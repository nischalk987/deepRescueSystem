import os
import smtplib
from email.mime.text import MIMEText
from dotenv import load_dotenv

load_dotenv()

def test_email():
    smtp_server = os.getenv("SMTP_SERVER", "smtp.gmail.com")
    smtp_port = int(os.getenv("SMTP_PORT", 587))
    smtp_user = os.getenv("SMTP_USER")
    smtp_pass = os.getenv("SMTP_PASSWORD")
    receiver = os.getenv("ALERT_RECEIVER")

    print("--- DeepRescue Email Diagnostics ---")
    print(f"Server: {smtp_server}:{smtp_port}")
    print(f"User: {smtp_user}")
    print(f"Receiver: {receiver}")
    
    if not all([smtp_user, smtp_pass, receiver]):
        print("\n❌ ERROR: Missing email settings in .env file!")
        print("Please fill in SMTP_USER, SMTP_PASSWORD, and ALERT_RECEIVER.")
        return

    try:
        print("\nConnecting to server...")
        server = smtplib.SMTP(smtp_server, smtp_port, timeout=10)
        server.starttls()
        print("Logging in...")
        server.login(smtp_user, smtp_pass)
        
        msg = MIMEText("This is a test alert from DeepRescue AI.")
        msg['Subject'] = "DeepRescue Test Alert"
        msg['From'] = smtp_user
        msg['To'] = receiver
        
        print(f"Sending test mail to {receiver}...")
        server.send_message(msg)
        server.quit()
        print("\n✅ SUCCESS: Email sent successfully!")
    except Exception as e:
        print(f"\n❌ FAILED: {str(e)}")
        if "Authentication failed" in str(e) or "Username and Password not accepted" in str(e):
            print("\n💡 TIP: If using Gmail, make sure you generated an 'App Password'.")
            print("Go to Google Account > Security > 2-Step Verification > App Passwords.")

if __name__ == "__main__":
    test_email()
