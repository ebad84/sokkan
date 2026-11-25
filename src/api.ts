let inMemoryToken: string | null = null;

export function setAuthToken(token: string | null): void {
  inMemoryToken = token;
}

export function getAuthToken(): string | null {
  return inMemoryToken;
}

export async function apiFetch<T>(url: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (inMemoryToken) {
    headers.set('X-Panel-Token', inMemoryToken);
  }
  if (init.body && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }

  const res = await fetch(url, { ...init, credentials: 'same-origin', headers });
  if (res.status === 401 && inMemoryToken) {
    inMemoryToken = null;
  }

  const text = await res.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { error: text };
  }

  if (!res.ok) {
    const errMsg =
      data && typeof data === 'object' && 'error' in data
        ? String((data as { error: unknown }).error)
        : `خطای سرور (${res.status})`;
    throw new Error(errMsg);
  }

  return data as T;
}

export function streamDeploymentLogs(
  deploymentId: string,
  callbacks: {
    onInit: (logs: string, status: string) => void;
    onChunk: (chunk: string) => void;
    onDone: (status: string) => void;
    onError: (err: string) => void;
  },
): () => void {
  const controller = new AbortController();

  const run = async () => {
    try {
      const headers = new Headers();
      if (inMemoryToken) {
        headers.set('X-Panel-Token', inMemoryToken);
      }
      const res = await fetch(`/api/deployments/${encodeURIComponent(deploymentId)}/stream`, {
        credentials: 'same-origin',
        headers,
        signal: controller.signal,
      });
      if (!res.ok || !res.body) {
        callbacks.onError('اتصال به جریان لاگ‌ها برقرار نشد.');
        return;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        const frames = buffer.split('\n\n');
        buffer = frames.pop() ?? '';

        for (const frame of frames) {
          let eventName = 'message';
          let dataLine = '';
          for (const line of frame.split('\n')) {
            if (line.startsWith('event:')) {
              eventName = line.slice(6).trim();
            } else if (line.startsWith('data:')) {
              dataLine += line.slice(5).trim();
            }
          }
          if (!dataLine) continue;
          try {
            const parsed = JSON.parse(dataLine) as Record<string, string>;
            if (eventName === 'init') {
              callbacks.onInit(parsed.logs ?? '', parsed.status ?? 'building');
            } else if (eventName === 'log') {
              callbacks.onChunk(parsed.chunk ?? '');
            } else if (eventName === 'done') {
              callbacks.onDone(parsed.status ?? 'success');
            }
          } catch {
            // Ignore malformed SSE frame
          }
        }
      }
    } catch (err) {
      if (!controller.signal.aborted) {
        callbacks.onError(err instanceof Error ? err.message : 'قطع ارتباط جریان لاگ');
      }
    }
  };

  void run();
  return () => controller.abort();
}
