# 📒 دفترچه هوشمند (Smart Notes)

هر چیزی رو کوتاه بنویس: تاریخ تعویض روغن، آدرس یک سایت، شماره تلفن، یک اتفاق…
هوش مصنوعی (Gemini یا هر سرویس سازگار با OpenAI / Anthropic) متن رو می‌خونه و **دسته، زیر دسته، عنوان، جزئیات و تگ‌های فارسی و انگلیسی** براش می‌سازه.

- 🖥️ **پنل وب** روی سرور خودت (Docker، بدون کامپایل)
- 📱 **اپ اندروید** با همون ظاهر، کاملاً **آفلاین**، با امکان اتصال به سرور
- 🔍 **جستجوی لحظه‌ای مثل گوگل**: با هر حرف نتیجه میاد، فارسی/انگلیسی، اعداد فارسی و لاتین، ی/ي و ک/ك یکی حساب میشن

---

## 🚀 نصب روی سرور (یک خط)

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/sahandfarshad/smart-notes/main/install.sh)
```

پورت، نام کاربری و رمز رو می‌پرسه، Docker رو (اگه نباشه) نصب می‌کنه، ایمیج آماده رو دانلود می‌کنه و منوی مدیریت باز میشه.
بعداً هر وقت خواستی:

```bash
smartnotes
```

منوی مدیریت (انگلیسی):

```
  Panel  : http://1.2.3.4:8080
  Status : running     SSL: off     User: admin
   1) Start                 8) Remove SSL
   2) Stop                  9) Show Android sync token
   3) Restart              10) Backup data
   4) Status & logs        11) Restore backup
   5) Change username / password
   6) Change port          12) Update
   7) Setup SSL            13) Uninstall
   0) Exit
```

- **SSL**: دامنه رو بده، گواهی رایگان Let's Encrypt با Caddy گرفته میشه و آدرس پنل `https://دامنه` میشه. با Remove SSL دوباره `http://IP:PORT` میشه.
- داده‌ها در `/opt/smart-notes/data` هستن.

## 📱 اپ اندروید

دانلود مستقیم آخرین نسخه:
**https://github.com/sahandfarshad/smart-notes/releases/latest/download/smart-notes.apk**

- بدون سرور کار می‌کنه؛ داده روی گوشی ذخیره میشه و کلید Gemini رو در تنظیمات اپ وارد می‌کنی.
- اگه آفلاین ثبت کنی، ذخیره میشه و وقتی اینترنت اومد خودکار دسته‌بندی میشه.

### اتصال به سرور
1. پنل وب › تنظیمات › «اتصال اپ اندروید» › کپی توکن (یا در SSH: `smartnotes` › گزینه 9)
2. اپ › تنظیمات › «اتصال به سرور» (اول صفحه) › چسباندن توکن › اتصال
3. تنظیمات هوش مصنوعی (کلید و مدل) از سرور روی گوشی میاد و همه یادداشت‌ها دوطرفه یکی میشن.
4. از اون به بعد همه‌چیز خودکار همگام میشه (باز کردن اپ، بعد از هر تغییر، هر یک دقیقه):
   هر یادداشت شناسه یکتای خودش رو داره؛ از هر طرف اضافه، ویرایش یا حذف بشه، طرف دیگه هم همون میشه. تغییر تنظیمات AI روی گوشی هم به سرور میره.

## 💾 پشتیبان و بازیابی
تنظیمات › پشتیبان و بازیابی: دانلود فایل JSON (اختیاری با کلیدهای API) و بازیابی به صورت «ادغام» یا «جایگزینی کامل».

## ⚙️ هوش مصنوعی
کلید API رو وارد کن و «دریافت مدل‌ها» رو بزن؛ همه مدل‌های موجود به صورت کارت میان. روی هر کارت بزنی تست میشه (یا «تست همه») و از بین سالم‌ها یکی رو انتخاب می‌کنی. اسم مدل دستی لازم نیست.

| سرویس | نوع | Base URL |
|---|---|---|
| Gemini | Gemini | `https://generativelanguage.googleapis.com/v1beta` |
| OpenAI | OpenAI-compatible | `https://api.openai.com/v1` |
| OpenRouter | OpenAI-compatible | `https://openrouter.ai/api/v1` |
| DeepSeek | OpenAI-compatible | `https://api.deepseek.com/v1` |
| Ollama | OpenAI-compatible | `http://SERVER:11434/v1` |
| Anthropic | Anthropic-compatible | `https://api.anthropic.com/v1` |

## 🛠️ برای توسعه
```bash
npm install && npm start      # http://localhost:8080
```
- `public/` رابط کاربری مشترک وب و اندروید (`core.js` هوش مصنوعی و جستجو، `store.js` لایه داده)
- `server.js` API و پنل وب، `cli.js` ابزار منوی SSH
- Actions: ایمیج Docker روی GHCR و APK در Releases

> کلید امضای APK (`android-signing/`) برای اینکه نسخه‌های جدید روی نسخه قبلی نصب بشن داخل ریپو است. چون ریپو عمومی است، اگر خواستی بعداً به GitHub Secrets منتقلش می‌کنیم.

## v4 – finding things (offline)
- **Browse tab**: tree (category › subcategory › notes, with counts and last date) and a Jalali timeline (year › month).
- **Topic card** (ℹ️ in the tree): count, last/first time, days since, usual interval and estimated next date, latest value of every field.
- **Persian-aware search**: ignores spaces/half-spaces, Persian suffixes (ها/های/…), and small typos.
- **Filters**: date range (7/30 days, this/last Jalali year) and kind (link, contact, amount, dated, idea).
- **Pinned notes** (synced), **recent searches**, **on this day in earlier years**, **related notes** in the editor.

## v4.2 – useful info (📎 کاربردی)
- New **کاربردی** tab for things you use every day: links, card numbers, addresses, and **images** (ID card, QR code, screenshots…).
- One tap copies the text; links have an open button; images can be copied (HTTPS) or shared/saved (Android share sheet, or download on HTTP).
- Images: pick a file, or paste with Ctrl+V on desktop. They are shrunk on the device (max 1800px JPEG) before saving.
- 🔒 **The AI never sees this section**: it lives in its own table (`infos`) on the server and its own store on the phone, and is never passed to the classifier.
- Synced with the Android app incrementally (only new or changed items travel, so images don't slow sync), and included in backup/restore.
