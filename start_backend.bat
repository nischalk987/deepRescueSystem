@echo off
cd backend
echo Checking dependencies...
pip install -r requirements.txt
echo.
echo ==========================================
echo Starting DeepRescue AI Backend
echo URL: http://localhost:8000
echo ==========================================
echo.
python app.py
pause
