import os
import cv2
import numpy as np
import base64
import shutil
import time
import smtplib
import threading
import winsound
import ctypes
from playsound import playsound
from email.mime.text import MIMEText
from email.mime.multipart import MIMEMultipart
from email.mime.image import MIMEImage
from typing import List, Optional
from datetime import datetime, timedelta

from fastapi import FastAPI, File, UploadFile, HTTPException, Depends, status, BackgroundTasks
from fastapi.responses import StreamingResponse
from fastapi.middleware.cors import CORSMiddleware
from fastapi.security import OAuth2PasswordBearer, OAuth2PasswordRequestForm
from ultralytics import YOLO
from motor.motor_asyncio import AsyncIOMotorClient
from passlib.context import CryptContext
from jose import JWTError, jwt
from pydantic import BaseModel, EmailStr
from dotenv import load_dotenv

load_dotenv()

app = FastAPI()

# MongoDB Setup
MONGODB_URL = os.getenv("MONGODB_URL", "mongodb://localhost:27017/deeprescue")
client = AsyncIOMotorClient(MONGODB_URL)
db = client.get_database()
users_collection = db.get_collection("users")

# Auth Setup
SECRET_KEY = os.getenv("SECRET_KEY", "super-secret-key-123")
ALGORITHM = "HS256"
pwd_context = CryptContext(schemes=["bcrypt"], deprecated="auto")
oauth2_scheme = OAuth2PasswordBearer(tokenUrl="login")

# Email Setup
SMTP_SERVER = os.getenv("SMTP_SERVER", "smtp.gmail.com")
SMTP_PORT = int(os.getenv("SMTP_PORT", 587))
SMTP_USER = os.getenv("SMTP_USER", "")
SMTP_PASSWORD = os.getenv("SMTP_PASSWORD", "")
ALERT_RECEIVER = os.getenv("ALERT_RECEIVER", "")

# Enable CORS
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Global reference to main event loop, captured at startup
main_event_loop = None

@app.on_event("startup")
async def startup_event():
    global main_event_loop
    import asyncio
    main_event_loop = asyncio.get_event_loop()
    # Ensure system starts in clean state
    current_status["drowning_detected"] = False
    current_status["person_count"] = 0
    current_status["detections"] = []
    current_status["email_sent"] = False
    current_status["stream_active"] = False
    current_status["alert_muted"] = False
    current_status["event_notified"] = False
    current_status["active_stream_id"] = 0
    print("✅ System initialized in 'All Clear' state.")

@app.get("/")
async def root():
    return {"message": "DeepRescue AI API is online"}

# Models
class UserCreate(BaseModel):
    email: EmailStr
    password: str

class UserResponse(BaseModel):
    email: EmailStr

class Token(BaseModel):
    access_token: str
    token_type: str

# Helper Functions
def verify_password(plain_password, hashed_password):
    return pwd_context.verify(plain_password, hashed_password)

def get_password_hash(password):
    return pwd_context.hash(password)

def create_access_token(data: dict):
    to_encode = data.copy()
    expire = datetime.utcnow() + timedelta(minutes=1440)
    to_encode.update({"exp": expire})
    return jwt.encode(to_encode, SECRET_KEY, algorithm=ALGORITHM)

async def get_current_user(token: str = Depends(oauth2_scheme)):
    try:
        # Debug: Print token preview
        if token:
            print(f"Authenticating token: {token[:5]}...{token[-5:]}")
        
        payload = jwt.decode(token, SECRET_KEY, algorithms=[ALGORITHM])
        email: str = payload.get("sub")
        if email is None:
            print("Auth Error: Sub (email) missing from payload")
            raise HTTPException(status_code=401, detail="Invalid token: payload missing sub")
        user = await users_collection.find_one({"email": email})
        if user is None:
            print(f"Auth Error: User {email} not found in database")
            raise HTTPException(status_code=401, detail="User not found")
        return user
    except JWTError as e:
        print(f"Auth Error (JWTError): {str(e)}")
        raise HTTPException(status_code=401, detail=f"Could not validate credentials: {str(e)}")
    except Exception as e:
        print(f"Auth Error (General): {str(e)}")
        raise HTTPException(status_code=401, detail="Authentication error occurred")

async def send_email_alert(image_data, recipient_email: str):
    if not SMTP_USER or not SMTP_PASSWORD:
        print("ALERT: SMTP credentials not set. Cannot send email.")
        return

    def _threaded_email_send(img_data, recipients):
        try:
            msg = MIMEMultipart()
            msg['From'] = SMTP_USER
            msg['To'] = ", ".join(recipients)
            msg['Subject'] = "🚨 DeepRescue Alert – Possible Drowning Detected"

            body = """Warning! A possible drowning event has been detected by the DeepRescue monitoring system. 
Please check the attached image for details."""
            
            msg.attach(MIMEText(body, 'plain'))
            image = MIMEImage(img_data, name="drowning_screenshot.jpg")
            msg.attach(image)

            with smtplib.SMTP(SMTP_SERVER, SMTP_PORT, timeout=10) as server:
                server.starttls()
                server.login(SMTP_USER, SMTP_PASSWORD)
                server.send_message(msg)
            
            print(f"✅ Email alert sent successfully to: {', '.join(recipients)}")
        except Exception as e:
            print(f"❌ Failed to send email via thread: {e}")

    # Build recipient list
    recipients = []
    if recipient_email:
        recipients.append(recipient_email)
    
    if ALERT_RECEIVER and ALERT_RECEIVER not in recipients:
        recipients.append(ALERT_RECEIVER)
        
    if not recipients:
        print("ALERT: No recipients specified. Skipping email.")
        return

    # Run the blocking email sending in a separate thread to keep detection fast
    email_thread = threading.Thread(target=_threaded_email_send, args=(image_data, recipients), daemon=True)
    email_thread.start()
    current_status["email_sent"] = True

async def get_user_from_token_str(token: str):
    if not token:
        return None
    try:
        payload = jwt.decode(token, SECRET_KEY, algorithms=[ALGORITHM])
        email: str = payload.get("sub")
        if email is None:
            return None
        return await users_collection.find_one({"email": email})
    except JWTError:
        return None

# Auth Routes
@app.post("/signup", response_model=UserResponse)
async def signup(user: UserCreate):
    existing_user = await users_collection.find_one({"email": user.email})
    if existing_user:
        raise HTTPException(status_code=400, detail="Email already registered")
    
    hashed_password = get_password_hash(user.password)
    new_user = {"email": user.email, "password": hashed_password}
    await users_collection.insert_one(new_user)
    return {"email": user.email}

@app.post("/login", response_model=Token)
async def login(form_data: OAuth2PasswordRequestForm = Depends()):
    user = await users_collection.find_one({"email": form_data.username})
    if not user or not verify_password(form_data.password, user["password"]):
        raise HTTPException(status_code=400, detail="Incorrect email or password")
    
    access_token = create_access_token(data={"sub": user["email"]})
    return {"access_token": access_token, "token_type": "bearer"}

# Load YOLOv8 model
MODEL_PATH = "best.pt"
if not os.path.exists(MODEL_PATH):
    model = YOLO("yolov8n.pt")
else:
    model = YOLO(MODEL_PATH)

# Ensure UPLOAD_DIR is absolute and exists
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
UPLOAD_DIR = os.path.join(BASE_DIR, "uploads")
os.makedirs(UPLOAD_DIR, exist_ok=True)
print(f"📁 Storage initialized at: {UPLOAD_DIR}")

# Global variables
webcam_active = False
EMAIL_COOLDOWN = 30 # Seconds (Wait 30s before sending another email for the same event)
last_email_sent_time = 0

current_status = {
    "drowning_detected": False,
    "person_count": 0,
    "detections": [],
    "stream_active": False,
    "email_sent": False,
    "alert_muted": False,
    "event_notified": False,
    "active_stream_id": 0
}

def audio_alarm_thread_func():
    is_playing_mci = False
    # Use the user-provided MP3 for the alert
    file_path = r"C:\Windows\Media\drowning_detection.mp3"

    while True:
        try:
            should_play = current_status.get("drowning_detected", False) and not current_status.get("alert_muted", False)
            
            if should_play:
                # Trigger MCI Audio (continuous alert using drowning_detection.mp3)
                if not is_playing_mci:
                    ctypes.windll.winmm.mciSendStringW(f'close alert', None, 0, 0)
                    ctypes.windll.winmm.mciSendStringW(f'open "{file_path}" type mpegvideo alias alert', None, 0, 0)
                    ctypes.windll.winmm.mciSendStringW(f'play alert repeat', None, 0, 0)
                    is_playing_mci = True
                    print("🔊 Audio Alert Started")
            else:
                if is_playing_mci:
                    ctypes.windll.winmm.mciSendStringW(f'stop alert', None, 0, 0)
                    ctypes.windll.winmm.mciSendStringW(f'close alert', None, 0, 0)
                    is_playing_mci = False
                    print("🔇 Alert Stopped")
        except Exception as e:
            print(f"Audio Thread Error: {e}")
        
        # Poll slower when not detected, faster when detected
        time.sleep(0.1 if current_status.get("drowning_detected") else 0.5)

# Start background audio thread so it doesn't block the video stream Let  
alarm_thread = threading.Thread(target=audio_alarm_thread_func, daemon=True)
alarm_thread.start()



def generate_frames(source=0, recipient_email=None):
    global webcam_active, last_email_sent_time
    

    # If source is a string (file path), ensure it is absolute
    if isinstance(source, str):
        if not os.path.isabs(source):
            # Check if it's already in UPLOAD_DIR
            possible_path = os.path.join(UPLOAD_DIR, os.path.basename(source))
            if os.path.exists(possible_path):
                source = possible_path
            else:
                print(f"❌ ERROR: Video file not found at {source} or {possible_path}")
                current_status["stream_active"] = False
                return
        
        print(f"🎬 Opening video file: {source}")
        if not os.path.exists(source):
            print(f"❌ ERROR: File does not exist at {source}")
            current_status["stream_active"] = False
            return
    
    cap = cv2.VideoCapture(source)
    if not cap.isOpened():
        print(f"❌ ERROR: OpenCV failed to open source: {source}")
        current_status["stream_active"] = False
        return

    current_status["stream_active"] = True
    current_status["active_stream_id"] += 1
    my_stream_id = current_status["active_stream_id"]
    print(f"✅ Stream #{my_stream_id} successfully opened: {source}")

    # For real-time sync with video files
    fps = cap.get(cv2.CAP_PROP_FPS) or 30
    frame_delay = 1.0 / fps
    frame_count = 0
    
    while True:
        start_time = time.time()
        # Check control flags to stop loop
        if not current_status.get("stream_active", False) or current_status["active_stream_id"] != my_stream_id:
            print(f"🛑 Monitoring #{my_stream_id} stopped via global status.")
            break
            
        if source == 0 and not webcam_active:
            print("🛑 Webcam deactivated by user.")
            break
            
        success, frame = cap.read()
        if not success:
            if isinstance(source, str):
                print(f"🔄 Video end reached. Looping: {source}")
                cap.set(cv2.CAP_PROP_POS_FRAMES, 0)
                success, frame = cap.read()
                if not success:
                    break
            else:
                print(f"🏁 Stream source disconnected.")
                break
        
        frame_count += 1
        current_status["stream_active"] = True

        # YOLO Detection
        results = model(frame, conf=0.25, verbose=False)
        # Requirement 6: Clear bounding boxes and labels
        annotated_frame = results[0].plot(line_width=3, labels=True, boxes=True)

        drowning_detected = False
        person_count = len(results[0].boxes)
        detections = []
        
        for box in results[0].boxes:
            cls = int(box.cls[0])
            name = model.names[cls].lower()
            conf = float(box.conf[0])
            detections.append({"class": name, "confidence": conf})
            
            if name == "drowning" and conf > 0.50:
                drowning_detected = True

        # Update global status for polling ONLY if we are the active stream
        if current_status["active_stream_id"] == my_stream_id:
            current_status["drowning_detected"] = drowning_detected
            current_status["person_count"] = person_count
            current_status["detections"] = detections

        # Visual Alert: Blinking Text (blink on and off every 10 frames)
        if drowning_detected and not current_status.get("alert_muted", False):
            if frame_count % 20 < 10:
                cv2.putText(annotated_frame, "DROWNING DETECTED", (50, 50), 
                            cv2.FONT_HERSHEY_SIMPLEX, 1.5, (0, 0, 255), 4, cv2.LINE_AA)

        # Send email alert ONLY ONCE per detection event with cooldown
        if drowning_detected and current_status["active_stream_id"] == my_stream_id:
            now = time.time()
            if not current_status.get("event_notified", False) and (now - last_email_sent_time > EMAIL_COOLDOWN):
                _, email_buf = cv2.imencode('.jpg', annotated_frame)
                img_bytes = email_buf.tobytes()
                # Calling send_email_alert (now threaded)
                import asyncio
                try:
                    asyncio.run_coroutine_threadsafe(
                        send_email_alert(img_bytes, recipient_email),
                        main_event_loop
                    )
                    current_status["event_notified"] = True
                    last_email_sent_time = now
                    print(f"📧 Emergency email dispatched. Cooldown: {EMAIL_COOLDOWN}s")
                except Exception as e:
                    print(f"Error queuing email alert: {e}")
        elif not drowning_detected:
            # Reset local event notification flag when clear ONLY if we are the active stream 
            if current_status["active_stream_id"] == my_stream_id:
                current_status["event_notified"] = False

        # Encode and stream the YOLO-annotated frame
        ret, buffer = cv2.imencode('.jpg', annotated_frame, [cv2.IMWRITE_JPEG_QUALITY, 80]) # Lower quality for faster stream
        if not ret:
            continue
            
        yield (b'--frame\r\n'
               b'Content-Type: image/jpeg\r\n\r\n' + buffer.tobytes() + b'\r\n')
        
        # Performance/Sync Sleep
        elapsed = time.time() - start_time
        sleep_time = frame_delay - elapsed
        if sleep_time > 0 and source != 0: # Only sync for files, let webcam run full speed
            time.sleep(sleep_time)


    cap.release()
    # Cleanup only if we were the last active stream and not killed by a new one
    if current_status["active_stream_id"] == my_stream_id:
        current_status["drowning_detected"] = False
        current_status["person_count"] = 0
        current_status["detections"] = []
        current_status["event_notified"] = False
    
    print(f"🎬 Feed generator #{my_stream_id} closed.")

@app.get("/status")
async def get_status():
    return current_status

@app.post("/reset_email_status")
async def reset_email_status():
    current_status["email_sent"] = False
    return {"status": "Email status reset"}

@app.post("/reset_status")
async def reset_status():
    current_status["active_stream_id"] += 1 # Immediately invalidate all current detectors
    current_status["drowning_detected"] = False
    current_status["person_count"] = 0
    current_status["detections"] = []
    current_status["email_sent"] = False
    current_status["alert_muted"] = False
    current_status["event_notified"] = False
    current_status["stream_active"] = False
    
    # Force stop any audio
    ctypes.windll.winmm.mciSendStringW(f'stop alert', None, 0, 0)
    ctypes.windll.winmm.mciSendStringW(f'close alert', None, 0, 0)
    
    return {"status": "System status reset"}

@app.post("/stop_alert")
async def stop_alert():
    current_status["alert_muted"] = True
    # Force stop any currently playing audio via MCI
    ctypes.windll.winmm.mciSendStringW(f'stop alert', None, 0, 0)
    ctypes.windll.winmm.mciSendStringW(f'close alert', None, 0, 0)
    return {"status": "Alert muted"}

@app.get("/video_feed")
async def video_feed(video_path: Optional[str] = None, token: str = None):
    user = await get_user_from_token_str(token)
    email = user["email"] if user else None
    
    if not video_path:
        return StreamingResponse(generate_frames(0, email), media_type="multipart/x-mixed-replace; boundary=frame")
    full_path = os.path.join(UPLOAD_DIR, video_path)
    return StreamingResponse(generate_frames(full_path, email), media_type="multipart/x-mixed-replace; boundary=frame")

@app.get("/webcam_feed")
async def webcam_feed(token: str = None):
    user = await get_user_from_token_str(token)
    email = user["email"] if user else None
    return StreamingResponse(generate_frames(0, email), media_type="multipart/x-mixed-replace; boundary=frame")

@app.post("/start_webcam")
async def start_webcam(current_user: dict = Depends(get_current_user)):
    global webcam_active
    webcam_active = True
    return {"status": "Webcam initialized"}

@app.post("/stop_webcam")
async def stop_webcam(current_user: dict = Depends(get_current_user)):
    global webcam_active
    webcam_active = False
    return {"status": "Webcam deactivated"}

@app.post("/detect")
async def detect_objects(background_tasks: BackgroundTasks, file: UploadFile = File(...), current_user: dict = Depends(get_current_user)):
    print(f"🚀 Processing detection for user: {current_user['email']}")
    file_path = os.path.join(UPLOAD_DIR, file.filename)
    with open(file_path, "wb") as buffer:
        shutil.copyfileobj(file.file, buffer)

    ext = file.filename.split('.')[-1].lower()

    if ext in ['jpg', 'jpeg', 'png', 'webp']:
        results = model(file_path, conf=0.25)
        # Style boxes for images too
        annotated_img = results[0].plot(line_width=4, labels=True, boxes=True)
        _, buffer = cv2.imencode('.jpg', annotated_img)
        img_bytes = buffer.tobytes()
        img_base64 = base64.b64encode(img_bytes).decode('utf-8')
        
        drowning_detected = False
        for box in results[0].boxes:
            name = model.names[int(box.cls[0])].lower()
            conf = float(box.conf[0])
            if name == "drowning" and conf > 0.50:
                drowning_detected = True

        if drowning_detected:
            # Trigger audio alert via status if not muted
            if not current_status.get("alert_muted", False):
                # For single images, we set a temporary detective state to trigger the thread
                current_status["drowning_detected"] = True
            background_tasks.add_task(send_email_alert, img_bytes, current_user["email"])

        return {
            "type": "image",
            "image": img_base64,
            "drowning_detected": drowning_detected,
            "message": "Potential drowning detected!" if drowning_detected else "All clear."
        }
    
    if ext in ['mp4', 'avi', 'mov', 'mkv']:
        # For video, skip expensive initial detection to return immediately
        # The /video_feed will handle real-time frame-by-frame processing
        print(f"🎥 Video {file.filename} uploaded. Skipping pre-processing for immediate streaming.")
        return {
            "type": "video", 
            "filename": file.filename,
            "drowning_detected": False,
            "person_count": 0
        }
    
    return {"type": "unknown", "filename": file.filename}

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
