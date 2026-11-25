# مستند جامع معماری، فلسفه طراحی و راهنمای توسعه «سکان‌یار» (SokanYar)

> این سند برای این نوشته شده است که هر زمان (حتی چند ماه بعد) به پروژه برگشتید، بدون نیاز به گشتن در کل کدها، دقیقاً بدانید **چرا سکان‌یار ساخته شد، هر بخش چطور کار می‌کند، چه تصمیمات معماری و امنیتی گرفته شده، چه باگ‌های واقعی روی سرور ایران حل شده و چطور باید آن را ادامه داد.**

---

## ۱. چرا سکان‌یار ساخته شد؟ (مسئله و راه‌حل)

هنگام مدیریت یک **سرور مجازی سبک (مثلاً VPS با ۲ گیگابایت رم در ایران)** و دیپلوی چند پروژه شخصی/تیمی از GitHub، معمولاً بین دو گزینه نامناسب گیر می‌کنیم:

1. **ابزارهای سنگین مثل Coolify / CapRover / Dokploy:**
   - خودشون چند سرویس، دیتابیس (PostgreSQL/Redis) و ایجنت جدا بالا می‌آورند و بخش بزرگی از ۲ گیگابایت رم را می‌بلعند.
   - کنترل مستقیم روی `Caddyfile` (یا Traefik) را می‌گیرند و اعمال تنظیمات دستی (مثل Basic Auth سفارشی، ریدایرکت‌ها یا مسیرهای خاص) را سخت می‌کنند.
   - روی شبکه و اینترنت ایران به دلیل تحریم Docker Hub، `download.docker.com` و مخازن Alpine در مرحله نصب یا بیلد گیر می‌کنند.

2. **مدیریت کاملاً دستی با SSH + Portainer:**
   - برای هر آپدیت پروژه باید SSH زد، `git pull` کرد، بیلد گرفت، `Caddyfile` را دستی ویرایش کرد و Caddy را Reload زد.
   - Portainer به‌تنهایی CI/CD متصل به گیتهاب و مدیریت `Caddyfile` ندارد.

**سکان‌یار (SokanYar)** دقیقاً برای پر کردن این شکاف ساخته شد:
- **فوق‌العاده سبک:** یک کانتینر Node.js + SQLite (حدود ۶۰ تا ۱۲۰ مگابایت رم، با سقف `mem_limit: 300m`).
- **جایگزین Portainer:** اتصال مستقیم به `/var/run/docker.sock` برای مشاهده کانتینرها، مصرف منابع (CPU/RAM)، لاگ زنده و Start/Stop/Restart/Remove.
- **CI/CD واقعی متصل به گیتهاب:** تشخیص خودکار `Dockerfile` و `docker-compose.yml`، دیپلوی دستی، **GitHub Webhook** (با امضای HMAC-SHA256) و **Polling دوره‌ای** با استریم زنده لاگ بیلد (SSE).
- **کنترل کامل روی `Caddyfile`:** ویرایشگر زنده `Caddyfile` با اعتبارسنجی قبل از اعمال، Reload خودکار، تاریخچه نسخه‌ها (Snapshot) و Rollback آنی — بدون اینکه کنترل دستی شما را بگیرد.
- **بومی‌سازی‌شده برای VPS ایران:** نصب داکر از مخزن اوبونتو، رجیستری میرورهای ایرانی، حذف وابستگی به Alpine APK در بیلد پنل، Swap دو گیگابایتی و مدیریت محدودیت رم.

---

## ۲. معماری کلی سیستم و جریان ترافیک

تمام سرویس‌ها روی یک شبکه داخلی مشترک داکر به نام **`web`** قرار دارند. فقط کانتینر `caddy` پورت‌های `80` و `443` را روی سرور باز می‌کند و بقیه سرویس‌ها پشت آن ایزوله هستند:

```text
Internet / User / GitHub Webhook
          │
          ▼  (DNS / CDN — e.g. ArvanCloud)
┌──────────────────────────────────────────────────────────┐
│  Caddy v2 (container: caddy)  [ports: 80, 443, 443/udp]  │
│  - Auto SSL (Let's Encrypt)                              │
│  - Layer 1 Basic Auth on panel (except /api/webhooks/*)  │
│  - Reverse Proxy over Docker bridge network: "web"       │
└───────────┬──────────────────────────┬───────────────────┘
            │                          │
            ▼                          ▼
┌───────────────────────────┐  ┌─────────────────────────────┐
│ sokanyar-panel (:3000)    │  │ Deployed Projects           │
│ - Express + React SPA     │  │ - sokanyar-app1 (:80)       │
│ - SQLite (./data/panel.db)│  │ - sokanyar-app2 (:3000)     │
│ - /var/run/docker.sock    │  │ - sokanyar-api  (:8000)     │
│ - ./caddy:/etc/caddy (rw) │  │ (No host -p ports needed!)  │
└───────────────────────────┘  └─────────────────────────────┘
            │
            ▼ (Optional lightweight companion)
┌──────────────────────────────────────────────────────────┐
│ beszel (:8090) + beszel-agent (socket)  [status.<domain>]│
│ Optional: uptime-kuma (:3001)           [kuma.<domain>]  │
└──────────────────────────────────────────────────────────┘
```

### نکته بسیار مهم درباره پورت‌ها (چرا تداخل پیش نمی‌آید؟)
در حالت `Dockerfile`، سکان‌یار هنگام اجرای کانتینر پروژه از `-p` (پورت Host) استفاده **نمی‌کند**؛ فقط کانتینر را با نام یکتای `sokanyar-<slug>` به شبکه داخلی `web` وصل می‌کند.
- بنابراین می‌توانید هم‌زمان ۱۰ پروژه داشته باشید که همه داخل کانتینر خود روی پورت `80` یا `3000` گوش می‌دهند و **هیچ تداخلی رخ نمی‌دهد**؛ چون هر کانتینر IP و نام DNS اختصاصی خودش را دارد (`sokanyar-app1:80`، `sokanyar-app2:80`).
- **تنها موارد تداخل:**
  1. **دامنه تکراری در Caddy** (مثلاً دو پروژه با دامنه `app.example.com`) که سکان‌یار در سطح API جلوی آن را می‌گیرد (`409 Conflict`).
  2. **استفاده از `ports:` در `docker-compose.yml` پروژه‌ها:** اگر پروژه شما حالت `compose` دارد، بهتر است به‌جای `ports:` از `expose:` و اتصال به شبکه خارجی `web` استفاده کند تا پورت‌های Host اشغال نشوند.

---

## ۳. نقشه فایل‌های کد (Codebase Map)

### بک‌اند (Express + TypeScript + SQLite)
| مسیر فایل | مسئولیت |
| :--- | :--- |
| `/server.ts` | نقطه ورود سرور (پورت `3000`)؛ تعریف تمام روت‌های API، میدلور احراز هویت، مدیریت کوکی نشست ۳۰ روزه، Webhook گیتهاب (با `express.raw` قبل از `express.json`) و سرو فرانت‌اند در پروداکشن. |
| `/server/db.ts` | اتصال `better-sqlite3` در `data/panel.db` (با حالت WAL)، تعریف جداول (`settings`, `projects`, `deployments`, `caddy_snapshots`, `metric_samples`) و بارگذاری اولیه `Caddyfile` از دیسک. |
| `/server/crypto.ts` | هش رمز مدیر با `scrypt`، امضای توکن نشست با `HMAC-SHA256`، رمزنگاری اسرار (`AES-256-GCM`) برای توکن گیتهاب / Webhook Secret / Env پروژه، و اعتبارسنجی امضای `X-Hub-Signature-256` گیتهاب. |
| `/server/cicd.ts` | موتور کامل CI/CD: کلون/فچ گیت، نوشتن امن `.env` با پرمیشن `0600`، اجرای `docker build`/`docker run` یا `docker compose up -d --build`، پخش زنده لاگ‌ها روی `EventEmitter` برای SSE، و زمان‌بند پس‌زمینه (Polling گیتهاب هر ۳۰ ثانیه + نمونه‌برداری متریک سیستم هر ۶۰ ثانیه). |
| `/server/caddy.ts` | مدیریت `Caddyfile`؛ تولید خودکار بلوک `# BEGIN MANAGED ROUTES ... # END MANAGED ROUTES`، اعتبارسنجی و Reload زنده با اولویت `admin_api` ← **`docker_exec` (`docker exec caddy caddy validate/reload`)** ← `cli`، همراه با Rollback خودکار در صورت خطا. |
| `/server/docker.ts` | اجرای امن دستورات Docker CLI (`execFile` بدون shell injection) برای لیست کانتینرها، آمار زنده (`docker stats`)، لاگ کانتینر، عملیات Start/Stop/Restart/Remove و متریک‌های سیستم عامل (CPU/RAM/Disk). |
| `/server/github.ts` | پارس آدرس مخازن گیتهاب (HTTPS/SSH/owner-repo)، تحلیل خودکار مخزن از GitHub API (تشخیص `Dockerfile`/`compose`، استخراج `EXPOSE` و کلیدهای `.env.example`) و بررسی آخرین کامیت برای Polling. |
| `/server/beszel.ts` | اتصال اختیاری به API داخلی Beszel (`http://beszel:8090` — PocketBase) برای نمایش تاریخچه نموداری CPU/RAM/Disk/Network در داشبورد. |
| `/server/bootstrap.ts` | ژنراتور فایل‌های آماده نصب (`bootstrap-vps.sh`، `docker-compose.yml`، `Dockerfile`) برای بخش «راه‌اندازی و بکاپ» پنل. |

### فرانت‌اند (React 19 + Vite + Tailwind CSS v4 — فارسی RTL)
| مسیر فایل | مسئولیت |
| :--- | :--- |
| `/src/App.tsx` | اسکلت اصلی پنل، سایدبار راست‌چین، مدیریت تب‌ها، وضعیت احراز هویت و دراور سراسری لاگ دیپلوی. |
| `/src/api.ts` | کلاینت `apiFetch` (ارسال خودکار کوکی و هدر `X-Panel-Token`) و کلاینت `streamDeploymentLogs` برای خواندن استریم SSE لاگ‌های بیلد. |
| `/src/types.ts` | تایپ‌های مشترک TypeScript بین فرانت‌اند و پاسخ‌های API. |
| `/src/components/AuthGate.tsx` | صفحه ورود و تنظیم رمز اولیه مدیر (لایه دوم احراز هویت). |
| `/src/components/OverviewPage.tsx` | داشبورد نمای کلی: مصرف زنده CPU/RAM/Disk، نمودار تاریخچه (محلی یا Beszel)، تنظیم اتصال Beszel و لیست آخرین دیپلوی‌ها. |
| `/src/components/ProjectsPage.tsx` | مدیریت پروژه‌ها: فرم اتصال مخزن گیتهاب (پر شدن خودکار نام و اسلاگ از انتهای لینک ریپو)، تحلیل خودکار مخزن، ویرایش تنظیمات/Env/Webhook و دراور زنده لاگ دیپلوی. |
| `/src/components/ContainersPage.tsx` | جایگزین Portainer: لیست کانتینرهای داکر، آمار زنده مصرف، مشاهده لاگ کانتینر و کنترل Start/Stop/Restart/Remove. |
| `/src/components/CaddyPage.tsx` | ویرایشگر زنده `Caddyfile` کلی، جدول مسیرهای مدیریت‌شده پروژه‌ها، اعتبارسنجی، Reload و تاریخچه Rollback. |
| `/src/components/ProvisioningPage.tsx` | تولید اسکریپت راه‌اندازی VPS و خروجی/بازیابی بکاپ JSON تنظیمات پنل. |

### زیرساخت و استقرار (Deployment Files)
| فایل | توضیح |
| :--- | :--- |
| `/Dockerfile` | بیلد دومرحله‌ای روی `node:22-bookworm-slim` (با فال‌بک میرور دبیان ابر آروان)، کپی باینری `docker` و `docker-compose` از `docker:cli` (بدون نیاز به Alpine APK) و نصب پکیج‌ها با `--legacy-peer-deps`. |
| `/docker-compose.yml` | استک کامل: `caddy:2`، `sokanyar-panel`، `beszel`، و پروفایل‌های اختیاری `agent` (`beszel-agent`) و `kuma` (`uptime-kuma`) با محدودیت رم (`mem_limit`) و شبکه مشترک `web`. |
| `/bootstrap-vps.sh` | اسکریپت نصب صفر تا صد روی VPS جدید اوبونتو/دبیان (سازگار با ایران): Swap ۲GB، فایروال UFW، نصب `docker.io` + `docker-compose-v2`، تنظیم رجیستری میرورهای ایرانی، ساخت `Caddyfile` اولیه و ساخت اسکریپت کمکی `enable-agent.sh`. |

---

## ۴. مدل امنیتی و تصمیمات کلیدی

1. **احراز هویت دولایه (Two-Layer Auth):**
   - **لایه اول (در لبه سرور توسط Caddy):** `basic_auth` روی دامنه پنل با هش `bcrypt`. مسیر `/api/webhooks/*` با `@panel_protected { not path /api/webhooks/* }` از Basic Auth مستثنی شده تا گیتهاب بتواند Webhook بفرستد (امنیت Webhook با امضای `HMAC-SHA256` تضمین می‌شود).
   - **لایه دوم (در اپلیکیشن سکان‌یار):** رمز عبور مدیر (هش‌شده با `scrypt` در SQLite یا تنظیم‌شده با `PANEL_ADMIN_PASSCODE`). پس از ورود، یک کوکی **`HttpOnly; SameSite=Lax`** (`sokanyar_session`) با اعتبار **۳۰ روز** (`SESSION_TTL_DAYS`) ست می‌شود و در هدر هم از `X-Panel-Token` پشتیبانی می‌شود تا هرگز با هدر `Authorization: Basic` مرورگر تداخل نکند.

2. **چرا روی دامنه Beszel (`status.<domain>`) نباید `basic_auth` گذاشت؟**
   - Beszel روی PocketBase کار می‌کند که خودش برای JWT از هدر `Authorization` استفاده می‌کند. اگر Caddy روی دامنه Beszel `basic_auth` داشته باشد، مرورگر هدر `Authorization: Basic ...` را به PocketBase می‌فرستد و PocketBase خطای `401 Missing or invalid authentication` برمی‌گرداند. Beszel خودش سیستم لاگین داخلی دارد.

3. **چرا Reload کانتینر Caddy از طریق `docker exec` انجام می‌شود؟**
   - وقتی `sokanyar-panel` از داخل شبکه داکر به `http://caddy:2019` درخواست می‌فرستد، Caddy Admin API به دلیل محافظت `Host` header درخواست با `Host: caddy:2019` را با `403 Forbidden` رد می‌کند.
   - برای حل دائمی و امن این مسئله، `server/caddy.ts` به‌طور خودکار وجود کانتینر `caddy` را بررسی کرده و اعتبارسنجی و Reload را مستقیم با `docker exec caddy caddy validate ...` و `docker exec caddy caddy reload ...` انجام می‌دهد (بدون نیاز به باز کردن Admin API روی شبکه).

4. **رمزنگاری داده‌های حساس در دیتابیس:**
   - توکن‌های GitHub، کلیدهای Webhook و متغیرهای `.env` پروژه‌ها قبل از ذخیره در `panel.db` با `AES-256-GCM` و کلید `DATA_ENCRYPTION_KEY` (موجود در `/opt/sokanyar/.env`) رمزنگاری می‌شوند.
   - **مهم:** فایل `/opt/sokanyar/.env` را در بکاپ امن نگه دارید؛ بدون `DATA_ENCRYPTION_KEY` اسرار رمزنگاری‌شده در `panel.db` قابل رمزگشایی نیستند.

---

## ۵. نکات حیاتی که در اجرای واقعی روی VPS ایران یاد گرفتیم

این مشکلات در دنیای واقعی رخ دادند و برای همیشه در کد حل شده‌اند:

1. **تحریم `download.docker.com` (`curl 403`):** اسکریپت `bootstrap-vps.sh` به‌جای `get.docker.com`، پکیج‌های `docker.io` و `docker-compose-v2` را مستقیم از مخزن رسمی اوبونتو نصب می‌کند و میرورهای `docker.arvancloud.ir` و `registry.docker.ir` را در `/etc/docker/daemon.json` ست می‌کند.
2. **مشکل TLS مخازن `dl-cdn.alpinelinux.org` در بیلد ایمیج:** `Dockerfile` از `node:22-alpine` به `node:22-bookworm-slim` تغییر کرد و باینری‌های `docker` و `docker-compose` با `COPY --from=docker:cli` کپی شدند تا بیلد روی سرور ایران سریع و پایدار باشد.
3. **تداخل Peer Dependency در `vite@8` و `esbuild`:** در `Dockerfile` از `npm install --no-audit --no-fund --legacy-peer-deps` استفاده می‌شود.
4. **دو برابر شدن ساب‌دامین (مثل `sokkan.ceqom.ir.ceqom.ir`):** در `bootstrap-vps.sh` تابع `resolve_fqdn` اضافه شده تا اگر کاربر نام کامل دامنه را وارد کرد، دوباره `BASE_DOMAIN` به انتهای آن چسبانده نشود.
5. **تکرار دامنه در `Caddyfile` (`ambiguous site definition`):** اگر دامنه‌ای را قبلاً دستی در `Caddyfile` تعریف کرده باشید و هم‌زمان در پروژه‌های سکان‌یار هم همان دامنه را فعال کنید، `caddy validate` قبل از خراب شدن سرویس خطا می‌دهد؛ کافی است بلوک دستی تکراری را از ویرایشگر Caddy حذف کنید.

---

## ۶. راهنمای عملیات روزمره روی VPS (Cheatsheet)

### آپدیت کردن سکان‌یار به آخرین نسخه ریپو
```bash
cd /opt/sokanyar
git pull && sudo docker compose up -d --build sokanyar-panel
```
*(دیتابیس `data/panel.db` و فایل‌های `caddy/` در Volume هستند و پاک نمی‌شوند.)*

### Reload دستی Caddy در مواقع اضطراری
```bash
sudo docker exec caddy caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile
```

### بررسی لاگ‌های سرویس‌ها
```bash
cd /opt/sokanyar
sudo docker compose logs -f --tail 50 sokanyar-panel
sudo docker compose logs -f --tail 50 caddy
```

### فعال‌سازی Beszel Agent برای نمودار تاریخچه سرور
1. وارد `https://status.<your-domain>` شوید، روی **Add System** بزنید و `Host/IP` را `/beszel_socket/beszel.sock` بگذارید.
2. Public Key داده‌شده را کپی کرده و روی VPS اجرا کنید:
```bash
cd /opt/sokanyar
sudo ./enable-agent.sh
```

### تنظیم یک پروژه تست سریع (بدون نیاز به دانلود پکیج)
یک ریپو در گیتهاب با ۲ فایل بسازید:
- `Dockerfile`:
  ```dockerfile
  FROM caddy:2
  COPY index.html /usr/share/caddy/index.html
  EXPOSE 80
  ```
- `index.html`: هر صفحه HTML دلخواه.
- در DNS (مثلاً ابر آروان) یک رکورد `A` به IP سرور بسازید، در سکان‌یار ریپو را وصل کنید و دیپلوی بزنید.

---

## ۷. راهنمای توسعه و نقشه راه آینده (ادامه پروژه)

### اجرای محیط توسعه محلی
```bash
npm install --legacy-peer-deps
npm run dev      # اجرای Express + Vite روی پورت 3000
npm run lint     # بررسی تایپ‌های TypeScript (tsc --noEmit)
npm run build    # بیلد فرانت‌اند در dist/
```

### ایده اول برای توسعه بعدی: اتصال مستقیم به API ابر آروان (ArvanCloud CDN & DNS)
ساختار پیشنهادی برای پیاده‌سازی این ویژگی در آینده:
1. **ماژول جدید `/server/arvan.ts`:**
   - ذخیره امن `API Key` ابر آروان و `Base Domain` + `Server IP` در جدول `settings` با `encryptSecret()` (دقیقاً به الگوی `/server/beszel.ts`).
   - متدهای API ابر آروان (`https://napi.arvancloud.ir/cdn/4.0/domains/{domain}/dns-records`):
     - `listDnsRecords()` برای مشاهده رکوردهای موجود.
     - `upsertARecord(subdomain, ip, cloud)` برای ساخت یا آپدیت خودکار رکورد `A` هنگام افزودن دامنه به پروژه در سکان‌یار.
     - `deleteDnsRecord(recordId)` هنگام حذف پروژه (اختیاری).
     - `purgeCache(domain)` برای پاک‌سازی کش CDN پس از هر دیپلوی موفق در `server/cicd.ts`.
   - مدیریت هوشمند SSL: هنگام ساخت ساب‌دامین جدید، ابتدا رکورد با `cloud: false` ساخته شود تا Caddy گواهی Let's Encrypt بگیرد، و در صورت تمایل کاربر بعد از تأیید TLS، ابر CDN (`cloud: true`) روشن شود.
2. **روت‌های API در `/server.ts`:**
   - `GET/PUT /api/integrations/arvan`
   - `POST /api/integrations/arvan/sync-dns`
   - `POST /api/integrations/arvan/purge`
3. **رابط کاربری:**
   - یک چک‌باکس «ثبت خودکار رکورد DNS در ابر آروان» در مودال ساخت/ویرایش پروژه (`ProjectsPage.tsx`) و کارت تنظیمات API Key در تب **مدیریت Caddy** یا **راه‌اندازی و بکاپ**.

### سایر قابلیت‌های پیشنهادی آینده
- **اعلان دیپلوی (Notifications):** ارسال پیام موفقیت/خطای بیلد به تلگرام، بله یا Webhook دلخواه در پایان `executePipeline()` در `server/cicd.ts`.
- **تولید خودکار Webhook در گیتهاب:** اگر کاربر PAT با دسترسی `admin:repo_hook` داد، سکان‌یار خودش Webhook را در ریپوی گیتهاب ثبت کند.
- **پاک‌سازی خودکار ایمیج‌های قدیمی (`docker image prune`):** دکمه یا زمان‌بند هفتگی برای آزادسازی فضای دیسک VPSهای ۲۰ گیگابایتی.
