# 🛟 DeepRescue AI — Real-Time Drowning Detection System

A full-stack AI system that detects drowning events in real time using **YOLOv8**, streams annotated video via **MJPEG**, and sends **Gmail email alerts** when drowning is detected.

---

## 📁 Project Structure

```
drowing1/
├── backend/
│   ├── app.py            ← FastAPI server (main backend logic)
│   ├── best.pt           ← Trained YOLOv8 drowning detection model
│   ├── requirements.txt  ← Python dependencies
│   ├── .env              ← Email credentials & secrets (DO NOT share)
│   └── uploads/          ← Uploaded video/image files (auto-created)
│
├── frontend/
│   ├── src/
│   │   ├── App.jsx       ← Main React UI (detection feed, controls)
│   │   └── Auth.jsx      ← Login / Signup page
│   └── package.json
│
├── start_backend.bat     ← One-click backend starter (Windows)
├── start_frontend.bat    ← One-click frontend starter (Windows)
└── README.md
```

---

## ⚡ Quick Start

### Prerequisites
- Python 3.10+
- Node.js 18+
- MongoDB running locally on port `27017`

---

## 🚀 Starting the Backend

### Option 1 — Double-click (Windows)
```
Double-click: start_backend.bat
```

### Option 2 — Terminal
```bash
cd backend
pip install -r requirements.txt   # First time only
uvicorn app:app --reload --host 127.0.0.1 --port 8000
```

✅ Backend is ready when you see:
```
INFO:     Uvicorn running on http://127.0.0.1:8000
✅ System initialized in 'All Clear' state.
```

---

## 🚀 Starting the Frontend

### Option 1 — Double-click (Windows)
```
Double-click: start_frontend.bat
```

### Option 2 — Terminal
```bash
cd frontend
npm install      # First time only
npm run dev
```

✅ Frontend is ready when you see:
```
VITE  Local: http://localhost:5173/
```

Then open your browser at: **http://localhost:5173**

---

## 🛑 Stopping the Services

### Stop Backend
In the backend terminal, press:
```
Ctrl + C
```

### Stop Frontend
In the frontend terminal, press:
```
Ctrl + C
```

---

## 🔄 Full Pipeline

```
Select Video/Webcam
        ↓
Upload to FastAPI Backend   [POST /detect]
        ↓
YOLO Detection on each frame  (best.pt model)
        ↓
MJPEG stream with bounding boxes  [GET /video_feed]
        ↓
Detection Feed in browser shows live annotated video
        ↓
If drowning confidence > 50% → Gmail alert sent  📧
```

---

## 📧 Email Notification Code

### ➤ Where it is configured — `backend/.env`
```env
SMTP_SERVER=smtp.gmail.com
SMTP_PORT=587
SMTP_USER=your_email@gmail.com
SMTP_PASSWORD=your_gmail_app_password
ALERT_RECEIVER=recipient@gmail.com
```

> ⚠️ Use a **Gmail App Password**, not your regular password.
> Generate one at: https://myaccount.google.com/apppasswords

---

### ➤ Email sending function — `backend/app.py` (lines ~119–162)

```python
async def send_email_alert(image_data, recipient_email: str):
    # Builds a MIMEMultipart email with the drowning screenshot attached
    # Sends via SMTP (TLS) to both the logged-in user and ALERT_RECEIVER
```

### ➤ Where email is triggered — `backend/app.py` inside `generate_frames()`

```python
# Send email alert ONLY when drowning confidence > 50% (with cooldown)
if drowning_detected and (time.time() - last_email_time > EMAIL_COOLDOWN):
    asyncio.run_coroutine_threadsafe(
        send_email_alert(img_bytes, recipient_email),
        main_event_loop
    )
```

**Rules:**
- Only fires when `drowning` class confidence is **> 50%**
- Has a **1-second cooldown** between alerts (configurable via `EMAIL_COOLDOWN`)
- Sends the YOLO-annotated frame as a JPG attachment

---

## 🔑 Environment Variables (`backend/.env`)

| Variable | Description |
|---|---|
| `MONGODB_URL` | MongoDB connection string |
| `SECRET_KEY` | JWT signing secret |
| `SMTP_SERVER` | Gmail SMTP server (`smtp.gmail.com`) |
| `SMTP_PORT` | SMTP port (`587`) |
| `SMTP_USER` | Gmail address that sends alerts |
| `SMTP_PASSWORD` | Gmail App Password |
| `ALERT_RECEIVER` | Email address to receive all alerts |

---

## 📡 API Endpoints

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/` | Health check |
| `POST` | `/signup` | Register new user |
| `POST` | `/login` | Login, returns JWT token |
| `POST` | `/detect` | Upload image or video for detection |
| `GET` | `/video_feed` | MJPEG stream with YOLO bounding boxes |
| `GET` | `/webcam_feed` | Live webcam MJPEG stream |
| `POST` | `/start_webcam` | Activate webcam feed |
| `POST` | `/stop_webcam` | Deactivate webcam feed |
| `GET` | `/status` | Get current detection status |
| `POST` | `/reset_status` | Reset status to all-clear |

---

## 🧠 How YOLO Detection Works

1. Each video frame is passed to `best.pt` (custom YOLOv8 model)
2. Model returns bounding boxes with class labels and confidence scores
3. Boxes are drawn directly on the frame using `results[0].plot()`
4. Annotated frame is JPEG-encoded and streamed to the browser
5. **`drowning`** class at **>50% confidence** triggers the email alert

---

## 🐛 Common Issues

| Problem | Fix |
|---|---|
| `Could not import module "app"` | Run uvicorn from the `backend/` folder, not root |
| `DLL initialization failed` | Reinstall torch: `pip install torch torchvision --index-url https://download.pytorch.org/whl/cpu` |
| Detection feed shows "Awaiting Input" | Make sure backend is running first, then upload video |
| Email not sent | Check `.env` credentials; use Gmail App Password not regular password |
| Webcam not working | Use HTTP (not HTTPS) for localhost |

---

## 🔒 Security Notes

- **Never commit `.env`** to Git (it's in `.gitignore`)
- JWT tokens expire after **24 hours**
- CORS is open (`*`) for development — restrict in production

---

*Built with FastAPI · YOLOv8 · React · OpenCV · Gmail SMTP*
