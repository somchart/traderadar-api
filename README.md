# TradeRadar API Server

Backend proxy server สำหรับ TradeRadar dashboard  
Node.js + Express · Yahoo Finance · In-memory cache · API Key auth

---

## Architecture

```
Browser / iPhone
      │
      ▼
Netlify (stock-tracker.html)
      │  fetch('/api/quote?symbols=...')
      │  X-API-Key: your-secret-key
      ▼
TradeRadar API Server  ◄── Railway / Render / VPS
      │  cache HIT → return cached data (fast)
      │  cache MISS → fetch from Yahoo Finance
      ▼
Yahoo Finance API (no CORS issues — server-side)
```

---

## Endpoints

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/health` | ❌ | Server health + cache stats |
| GET | `/` | ❌ | API documentation |
| GET | `/api/quote?symbols=AAPL,GC=F` | ✅ | Stock quotes (max 20 symbols) |
| GET | `/api/spark?symbol=AAPL` | ✅ | Intraday chart data |
| GET | `/api/search?q=apple` | ✅ | Symbol search |
| GET | `/api/fear-greed` | ✅ | Crypto Fear & Greed Index |
| GET | `/api/fx?from=USD&to=THB` | ✅ | Exchange rate |
| GET | `/api/cache/clear` | ✅ | Clear cache |

---

## Deploy — Railway.app (แนะนำ ฟรี)

### ขั้นตอน:

**1. สร้าง GitHub repo**
```bash
git init
git add .
git commit -m "TradeRadar API v1.0"
# สร้าง repo ใหม่บน github.com แล้วรัน:
git remote add origin https://github.com/YOUR_USERNAME/traderadar-api.git
git push -u origin main
```

**2. Deploy บน Railway**
1. ไปที่ [railway.app](https://railway.app) → Sign up ด้วย GitHub
2. กด **"New Project"** → **"Deploy from GitHub repo"**
3. เลือก repo `traderadar-api`
4. Railway จะ detect Node.js และ build อัตโนมัติ

**3. ตั้ง Environment Variables ใน Railway**
```
Settings → Variables → Add Variable:

API_KEY        = (สร้าง key แข็งแรง ดูข้างล่าง)
CACHE_TTL_MS   = 300000
RATE_LIMIT     = 60
ALLOWED_ORIGIN = https://your-app.netlify.app
```

**สร้าง API Key แข็งแรง:**
```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

**4. รับ URL**  
Railway จะให้ URL เช่น: `https://traderadar-api.up.railway.app`

---

## Deploy — Render.com (ฟรีอีกตัวเลือก)

1. ไปที่ [render.com](https://render.com) → New → Web Service
2. Connect GitHub repo
3. ตั้งค่า:
   - **Build Command:** `npm install`
   - **Start Command:** `node server.js`
4. Add Environment Variables เหมือน Railway
5. Deploy!

> ⚠️ Free tier บน Render จะ sleep หลัง 15 นาที → ครั้งแรกอาจช้า 30 วิ

---

## Deploy — VPS (Ubuntu/Debian)

```bash
# 1. Install Node.js 20
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs

# 2. Clone และ install
git clone https://github.com/YOUR_USERNAME/traderadar-api.git
cd traderadar-api
npm install --production

# 3. ตั้งค่า environment
cp .env.example .env
nano .env   # แก้ไข API_KEY และค่าอื่นๆ

# 4. Run ด้วย PM2 (keep alive)
sudo npm install -g pm2
pm2 start server.js --name traderadar-api
pm2 startup    # auto-start on reboot
pm2 save

# 5. Nginx reverse proxy (optional แต่แนะนำ)
sudo apt install nginx
sudo nano /etc/nginx/sites-available/traderadar

# ใส่ config นี้:
server {
    listen 80;
    server_name api.yourdomain.com;
    location / {
        proxy_pass http://localhost:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    }
}

sudo ln -s /etc/nginx/sites-available/traderadar /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx

# 6. SSL ด้วย Let's Encrypt
sudo apt install certbot python3-certbot-nginx
sudo certbot --nginx -d api.yourdomain.com
```

---

## ทดสอบ API

```bash
# Local
node test.js

# Production
node test.js https://traderadar-api.up.railway.app your-api-key
```

---

## อัปเดต stock-tracker.html ให้ใช้ Backend ใหม่

เปลี่ยนใน HTML จาก allorigins proxy เป็น backend ของเรา:

```javascript
// ตั้งค่าที่หัวไฟล์ HTML
const API_BASE = 'https://traderadar-api.up.railway.app'; // URL จาก Railway
const API_KEY  = 'your-secret-api-key';                   // key ที่ตั้งใน env

// แทนที่ fetchJSON ด้วย:
async function apiFetch(endpoint) {
  const res = await fetch(API_BASE + endpoint, {
    headers: { 'X-API-Key': API_KEY }
  });
  if (!res.ok) throw new Error('API error: ' + res.status);
  return res.json();
}

// ตัวอย่าง:
const data = await apiFetch('/api/quote?symbols=AAPL,PTT.BK,GC=F');
const spark = await apiFetch('/api/spark?symbol=AAPL');
```

---

## Environment Variables Reference

| Variable | Default | Description |
|----------|---------|-------------|
| `API_KEY` | `change-me-in-env` | **Required** — API Key สำหรับ auth |
| `PORT` | `3000` | Port (Railway ตั้งให้อัตโนมัติ) |
| `CACHE_TTL_MS` | `300000` | Cache TTL (ms) — 300000 = 5 นาที |
| `RATE_LIMIT` | `60` | Max requests/min per IP |
| `ALLOWED_ORIGIN` | `*` | CORS origin (ตั้งเป็น Netlify URL) |

---

## Local Development

```bash
npm install
cp .env.example .env
# แก้ไข .env ตามต้องการ
npm run dev    # nodemon auto-restart
```

```bash
# ทดสอบ endpoint:
curl http://localhost:3000/health
curl -H "X-API-Key: your-key" "http://localhost:3000/api/quote?symbols=AAPL"
curl -H "X-API-Key: your-key" "http://localhost:3000/api/fear-greed"
curl -H "X-API-Key: your-key" "http://localhost:3000/api/fx?from=USD&to=THB"
```
