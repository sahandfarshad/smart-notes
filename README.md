# 📒 دفترچه هوشمند (Smart Notes)

هر چیزی رو کوتاه بنویس: تاریخ تعویض روغن، آدرس یک سایت، شماره تلفن، یک اتفاق…
هوش مصنوعی (Gemini یا هر سرویس سازگار با OpenAI / Anthropic) متن رو می‌خونه، **دسته و زیر دسته**، **عنوان**، **فیلدهای ساختاریافته** و **تگ‌های فارسی و انگلیسی** براش می‌سازه و در یک دیتابیس SQLite ذخیره می‌کنه.

## امکانات
- ➕ **ثبت سریع** با یک کادر متن (Ctrl+Enter)
- 📋 **جدول**: هر دسته یک جدول جدا با ستون‌های مخصوص خودش (مثلاً تاریخ و کیلومتر برای ماشین)
- 🌳 **درخت**: دسته‌ها و زیر دسته‌ها مثل پوشه
- 🔍 **جستجوی متن کامل** (FTS5 trigram) روی متن، عنوان، تگ‌ها و فیلدها؛ فارسی و انگلیسی
- ⚙️ **چند سرویس هوش مصنوعی**: Gemini (پیش‌فرض)، OpenAI-compatible (OpenAI، OpenRouter، DeepSeek، Groq، Ollama…)، Anthropic-compatible. یکی رو فعال می‌کنی.
- ✏️ ویرایش دستی، دسته‌بندی دوباره با AI، حذف
- 💾 خروجی و ورود JSON برای پشتیبان
- 📱 PWA: روی گوشی و کامپیوتر «نصب» می‌شه
- 🔒 رمز عبور اختیاری با `APP_PASSWORD`

## نصب روی سرور (Docker)
ایمیج با هر push توسط GitHub Actions ساخته و روی GHCR منتشر می‌شه (amd64 و arm64):

```bash
mkdir smart-notes && cd smart-notes
curl -O https://raw.githubusercontent.com/sahandfarshad/smart-notes/main/docker-compose.yml
# APP_PASSWORD رو در فایل عوض کن
docker compose up -d
```
بعد برو به `http://SERVER-IP:8080` → تنظیمات → کلید Gemini رو وارد کن.
دیتابیس در پوشه‌ی `./data` می‌مونه. برای HTTPS (لازم برای نصب PWA) پشت Caddy یا Nginx بذارش.

به‌روزرسانی:
```bash
docker compose pull && docker compose up -d
```

## اجرای محلی
```bash
npm install
npm start   # http://localhost:8080
```

## متغیرهای محیطی
| متغیر | توضیح |
|---|---|
| `PORT` | پورت (پیش‌فرض 8080) |
| `DATA_DIR` | محل دیتابیس (پیش‌فرض `./data`) |
| `APP_PASSWORD` | اگر تنظیم بشه، برای ورود رمز می‌خواد |
| `GEMINI_API_KEY` | اختیاری؛ کلید اولیه Gemini |

## نمونه‌های Base URL
| سرویس | نوع | Base URL |
|---|---|---|
| Gemini | Gemini | `https://generativelanguage.googleapis.com/v1beta` |
| OpenAI | OpenAI-compatible | `https://api.openai.com/v1` |
| OpenRouter | OpenAI-compatible | `https://openrouter.ai/api/v1` |
| DeepSeek | OpenAI-compatible | `https://api.deepseek.com/v1` |
| Ollama (محلی) | OpenAI-compatible | `http://localhost:11434/v1` |
| Anthropic | Anthropic-compatible | `https://api.anthropic.com/v1` |

## ساختار
- `server.js` — Express + better-sqlite3 + FTS5 + اتصال به AI
- `public/` — رابط کاربری (HTML/CSS/JS بدون build)
- `.github/workflows/docker.yml` — ساخت و انتشار ایمیج Docker
