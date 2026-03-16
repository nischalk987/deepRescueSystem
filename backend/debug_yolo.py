try:
    from ultralytics import YOLO
    import os
    print("Ultralytics imported successfully")
    MODEL_PATH = "best.pt"
    if os.path.exists(MODEL_PATH):
        print(f"Loading {MODEL_PATH}...")
        model = YOLO(MODEL_PATH)
        print("Model loaded successfully")
    else:
        print(f"Error: {MODEL_PATH} not found")
except Exception as e:
    print(f"Error occurred: {e}")
