import os
import cv2
import numpy as np
import base64
import shutil
import time
import smtplib
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

    try:
        # Build recipient list
        recipients = []
        if recipient_email:
            recipients.append(recipient_email)
        
        if ALERT_RECEIVER and ALERT_RECEIVER not in recipients:
            recipients.append(ALERT_RECEIVER)
            
        if not recipients:
            print("ALERT: No recipients specified (both user and admin missing). Skipping email.")
            return

        print(f"Attempting to send emergency email alert to: {', '.join(recipients)}")

        msg = MIMEMultipart()
        msg['From'] = SMTP_USER
        msg['To'] = ", ".join(recipients)
        msg['Subject'] = "🚨 DeepRescue Alert – Possible Drowning Detected"

        body = """Warning! A possible drowning event has been detected by the DeepRescue monitoring system. 
Please check the attached image for details."""
        
        msg.attach(MIMEText(body, 'plain'))

        # Attach image
        image = MIMEImage(image_data, name="drowning_screenshot.jpg")
        msg.attach(image)

        # Send email
        with smtplib.SMTP(SMTP_SERVER, SMTP_PORT) as server:
            server.starttls()
            server.login(SMTP_USER, SMTP_PASSWORD)
            server.send_message(msg)
            
        current_status["email_sent"] = True
        print(f"✅ Email alert sent successfully to: {', '.join(recipients)}")
    except Exception as e:
        print(f"❌ Failed to send email: {e}")

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
last_email_time = 0
EMAIL_COOLDOWN = 1 # Seconds (Reduced for high-frequency alerts)

current_status = {
    "drowning_detected": False,
    "person_count": 0,
    "detections": [],
    "stream_active": False,
    "email_sent": False
}



def generate_frames(source=0, recipient_email=None):
    global webcam_active, last_email_time
    

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
    print(f"✅ Stream successfully opened: {source}")

    frame_count = 0
    
    while True:
        # Check webcam control flag
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
        results = model(frame, conf=0.25)
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

        # Update global status for polling
        current_status["drowning_detected"] = drowning_detected
        current_status["person_count"] = person_count
        current_status["detections"] = detections

        # Send email alert ONLY when drowning confidence > 50% (already enforced above)
        if drowning_detected and (time.time() - last_email_time > EMAIL_COOLDOWN):
            _, email_buf = cv2.imencode('.jpg', annotated_frame)
            img_bytes = email_buf.tobytes()
            if main_event_loop and main_event_loop.is_running():
                import asyncio
                try:
                    asyncio.run_coroutine_threadsafe(
                        send_email_alert(img_bytes, recipient_email),
                        main_event_loop
                    )
                    last_email_time = time.time()
                    print(f"📧 Email alert queued – drowning at {[d['confidence'] for d in detections if d['class']=='drowning']}")
                except Exception as e:
                    print(f"Error queuing email alert: {e}")

        # Encode and stream the YOLO-annotated frame
        ret, buffer = cv2.imencode('.jpg', annotated_frame, [cv2.IMWRITE_JPEG_QUALITY, 85])
        if not ret:
            continue
            
        yield (b'--frame\r\n'
               b'Content-Type: image/jpeg\r\n\r\n' + buffer.tobytes() + b'\r\n')
        
        # ~25 FPS
        time.sleep(0.04)


    cap.release()
    current_status["stream_active"] = False
    current_status["drowning_detected"] = False
    current_status["person_count"] = 0
    current_status["detections"] = []
    print("🎬 Feed generator closed.")

@app.get("/status")
async def get_status():
    return current_status

@app.post("/reset_email_status")
async def reset_email_status():
    current_status["email_sent"] = False
    return {"status": "Email status reset"}

@app.post("/reset_status")
async def reset_status():
    current_status["drowning_detected"] = False
    current_status["person_count"] = 0
    current_status["detections"] = []
    current_status["email_sent"] = False
    return {"status": "System status reset"}

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
            background_tasks.add_task(send_email_alert, img_bytes, current_user["email"])

        return {
            "type": "image",
            "image": img_base64,
            "drowning_detected": drowning_detected,
            "message": "Potential drowning detected!" if drowning_detected else "All clear."
        }
    
    if ext in ['mp4', 'avi', 'mov', 'mkv']:
        # For video, do an initial detection on the first frame
        cap = cv2.VideoCapture(file_path)
        success, frame = cap.read()
        cap.release()
        
        drowning_detected = False
        person_count = 0
        
        if success:
            # Use same conf as stream for consistency
            results = model(frame, conf=0.25)
            person_count = len(results[0].boxes)
            print(f"📊 Initial Frame Check: Found {person_count} persons")
            for box in results[0].boxes:
                name = model.names[int(box.cls[0])].lower()
                conf = float(box.conf[0])
                if name == "drowning" and conf > 0.50:
                    drowning_detected = True
            
            # Send immediate email if detected on first frame
            if drowning_detected:
                annotated_img = results[0].plot()
                _, buffer = cv2.imencode('.jpg', annotated_img)
                img_bytes = buffer.tobytes()
                background_tasks.add_task(send_email_alert, img_bytes, current_user["email"])
        
        return {
            "type": "video", 
            "filename": file.filename,
            "drowning_detected": drowning_detected,
            "person_count": person_count
        }
    
    return {"type": "unknown", "filename": file.filename}

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
