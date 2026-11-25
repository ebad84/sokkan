# سکان‌یار (SokanYar) — پنل اتوماتیک CI/CD و مدیریت VPS

پنل خودمیزبان و سبک برای اتصال مخازن گیتهاب به سرور VPS، تشخیص خودکار `Dockerfile` و `docker-compose.yml`، دیپلوی اتوماتیک با **Webhook** و **Polling**، کنترل مستقیم کانتینرهای داکر (بدون نیاز به Portainer)، ویرایش زنده `Caddyfile` با قابلیت بازگشت (Rollback) و بکاپ/بازیابی یکپارچه.

## راه‌اندازی صفر تا صد روی سرور VPS جدید (Ubuntu / Debian)

۱. مخزن را روی سرور کلون کنید:

```bash
sudo apt-get update && sudo apt-get install -y git
git clone https://github.com/ebad84/sokkan-yar.git /opt/sokanyar
cd /opt/sokanyar
```

۲. اسکریپت نصب کامل را اجرا کنید:

```bash
chmod +x bootstrap-vps.sh
bash bootstrap-vps.sh
```

این اسکریپت به صورت خودکار موارد زیر را انجام می‌دهد:
- نصب `Docker` و `Docker Compose`
- فعال‌سازی ۲ گیگابایت `Swap` در صورت نبود (مناسب سرورهای ۲ گیگابایت رم)
- پیکربندی فایروال `UFW` برای پورت‌های `22`، `80` و `443`
- ساخت شبکه مشترک `caddy_net` و تولید کلیدهای امنیتی یکتا در `.env`
- راه‌اندازی `Caddy` و `سکان‌یار` (و در صورت تمایل `Beszel` و `Uptime Kuma`)

۳. مرورگر را روی دامنه (یا IP سرور) باز کنید و در اولین اجرا رمز مدیر پنل را ثبت نمایید.
