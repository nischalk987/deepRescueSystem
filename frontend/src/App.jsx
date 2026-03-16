import React, { useState, useRef, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { 
  Upload, 
  ShieldAlert, 
  Camera, 
  Video, 
  CheckCircle, 
  AlertCircle, 
  Bell, 
  Mail, 
  Cpu, 
  Github,
  ChevronRight,
  Loader2,
  Play,
  Square,
  Activity,
  User,
  Zap
} from 'lucide-react';
import axios from 'axios';
import Auth from './Auth';

const App = () => {
  const [token, setToken] = useState(localStorage.getItem('token'));
  const [file, setFile] = useState(null);
  const [preview, setPreview] = useState(null);
  const [videoPreviewUrl, setVideoPreviewUrl] = useState(null);
  const [loading, setLoading] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [mode, setMode] = useState('image');
  const [streamUrl, setStreamUrl] = useState(null);
  const [isMonitoring, setIsMonitoring] = useState(false);
  const [drowningDetected, setDrowningDetected] = useState(false);
  const [personCount, setPersonCount] = useState(0);
  const [results, setResults] = useState(null);
  const [emailStatus, setEmailStatus] = useState(null);
  const [showEmailPopup, setShowEmailPopup] = useState(false);
  const fileInputRef = useRef(null);
  const abortControllerRef = useRef(null);
  // Track whether the stream was ever confirmed active (prevents race-condition premature kill)
  const streamWasActiveRef = useRef(false);
  const streamInactiveCountRef = useRef(0);

  // Reset status on initial load to prevent persistent blinking from old states
  useEffect(() => {
    if (token) {
      axios.post('http://127.0.0.1:8000/reset_status', {}, {
        headers: { 'Authorization': `Bearer ${token}` }
      }).catch(err => console.error("Initial status reset failed", err));
    }
  }, [token]);

  // Polling for status updates during live streams
  useEffect(() => {
    let interval;
    if (isMonitoring || (drowningDetected && !showEmailPopup)) {
      interval = setInterval(async () => {
        try {
          const statusRes = await axios.get('http://127.0.0.1:8000/status', {
            headers: { 'Authorization': `Bearer ${token}` }
          });
          
          setDrowningDetected(statusRes.data.drowning_detected);
          setPersonCount(statusRes.data.person_count);
          
          if (statusRes.data.email_sent && !showEmailPopup) {
            setShowEmailPopup(true);
            setEmailStatus('sent');
            await axios.post('http://127.0.0.1:8000/reset_email_status', {}, {
              headers: { 'Authorization': `Bearer ${token}` }
            });
          }

          if (isMonitoring) {
            setResults(prev => ({
              ...prev,
              detections: statusRes.data.detections
            }));

            // Track when stream first becomes active
            if (statusRes.data.stream_active) {
              streamWasActiveRef.current = true;
              streamInactiveCountRef.current = 0;
            } else if (streamWasActiveRef.current) {
              // Only stop if stream was previously active AND has been inactive for 5+ polls
              streamInactiveCountRef.current += 1;
              if (streamInactiveCountRef.current >= 5 && mode !== 'webcam') {
                setIsMonitoring(false);
                setStreamUrl(null);
                streamWasActiveRef.current = false;
                streamInactiveCountRef.current = 0;
              }
            }
            // If stream was NEVER active yet, don't kill it — it's just starting up
          }
        } catch (e) {
          if (e.response?.status === 401) {
            handleLogout();
          }
          console.error("Status polling failed");
        }
      }, 500);
    }
    return () => clearInterval(interval);
  }, [isMonitoring, drowningDetected, showEmailPopup, token]);

  // Health check for backend
  useEffect(() => {
    const checkBackend = async () => {
      try {
        await axios.get('http://127.0.0.1:8000/');
      } catch (e) {
        console.error("Backend not reachable");
      }
    };
    checkBackend();
  }, []);

  const handleFileChange = (e) => {
    const selectedFile = e.target.files[0];
    if (selectedFile) {
      setFile(selectedFile);
      if (selectedFile.type.startsWith('video/')) {
        const blobUrl = URL.createObjectURL(selectedFile);
        setPreview(blobUrl);
        setVideoPreviewUrl(blobUrl);
      } else {
        const reader = new FileReader();
        reader.onloadend = () => setPreview(reader.result);
        reader.readAsDataURL(selectedFile);
        setVideoPreviewUrl(null);
      }
      setResults(null);
      setStreamUrl(null);
      setIsMonitoring(false);
    }
  };

  const startAnalysis = async () => {
    if (!file) {
      alert("Please select a file first.");
      return;
    }
    setUploading(true);
    setLoading(true);
    setDrowningDetected(false);
    setShowEmailPopup(false);
    setEmailStatus(null);
    setStreamUrl(null);
    setIsMonitoring(false);
    // Reset stream tracking for this new session
    streamWasActiveRef.current = false;
    streamInactiveCountRef.current = 0;

    try {
      await axios.post('http://127.0.0.1:8000/reset_status', {}, {
        headers: { 'Authorization': `Bearer ${token}` }
      });
    } catch(e) { /* ignore */ }
    
    abortControllerRef.current = new AbortController();
    const formData = new FormData();
    formData.append('file', file);

    try {
      console.log(`Uploading ${file.name} to backend...`);
      const response = await axios.post('http://127.0.0.1:8000/detect', formData, {
        headers: {
          'Content-Type': 'multipart/form-data',
          'Authorization': `Bearer ${token}`
        },
        signal: abortControllerRef.current.signal
      });
      console.log("Backend response:", response.data);
      
      if (mode === 'image' && response.data.type === 'image') {
        setResults(response.data);
        setDrowningDetected(response.data.drowning_detected);
        setPersonCount(response.data.person_count);
        if (response.data.drowning_detected) {
          setEmailStatus('sending');
        }
        setLoading(false);
        setUploading(false);
      } else if (response.data.type === 'video') {
        console.log("📹 Video uploaded, starting stream feed:", response.data);
        setResults(response.data);
        setPersonCount(response.data.person_count);
        if (response.data.drowning_detected) {
          setEmailStatus('sending');
        }
        
        // CRITICAL: Clear loading BEFORE setting streamUrl so the <img> tag renders
        setLoading(false);
        setUploading(false);

        // Construct stream URL using just the filename (not full path)
        const streamBase = 'http://127.0.0.1:8000/video_feed';
        const params = new URLSearchParams({
          video_path: response.data.filename,
          token: token,
          t: Date.now()
        });
        const newUrl = `${streamBase}?${params.toString()}`;
        
        console.log("🔗 Starting Detection Feed:", newUrl);
        setStreamUrl(newUrl);
        setIsMonitoring(true);
      }
    } catch (error) {
      if (axios.isCancel(error)) {
        console.log("Request cancelled");
      } else {
        console.error("Upload error:", error);
        if (error.response?.status === 401) {
          alert("Your session has expired. Please login again.");
          handleLogout();
        } else {
          alert(`Upload failed: ${error.response?.data?.detail || error.message}. Make sure backend is running at http://127.0.0.1:8000`);
        }
      }
      setLoading(false);
      setUploading(false);
    }
  };

  const stopAnalysis = () => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
    }
    setLoading(false);
    setUploading(false);
    setResults(null);
    setFile(null);
    setPreview(null);
    setVideoPreviewUrl(null);
    setDrowningDetected(false);
    setShowEmailPopup(false);
    setIsMonitoring(false);
    setStreamUrl(null);
    if (fileInputRef.current) fileInputRef.current.value = "";
    
    axios.post('http://127.0.0.1:8000/reset_status', {}, {
      headers: { 'Authorization': `Bearer ${token}` }
    });
  };

  const toggleWebcam = async () => {
    try {
      if (isMonitoring) {
        await axios.post('http://127.0.0.1:8000/stop_webcam', {}, {
          headers: { 'Authorization': `Bearer ${token}` }
        });
        setStreamUrl(null);
        setIsMonitoring(false);
        setDrowningDetected(false);
      } else {
        setMode('webcam');
        await axios.post('http://127.0.0.1:8000/start_webcam', {}, {
          headers: { 'Authorization': `Bearer ${token}` }
        });
        const webcamUrl = `http://127.0.0.1:8000/webcam_feed?token=${encodeURIComponent(token)}&t=${Date.now()}`;
        console.log("📷 Starting Webcam Stream:", webcamUrl);
        setStreamUrl(webcamUrl);
        setIsMonitoring(true);
      }
    } catch (e) {
      if (e.response?.status === 401) {
        handleLogout();
      }
      console.error("Webcam toggle failed", e);
    }
  };

  const stopMonitoring = () => {
    setStreamUrl(null);
    setIsMonitoring(false);
    setDrowningDetected(false);
    
    // Reset backend status to stop blinking
    axios.post('http://127.0.0.1:8000/reset_status', {}, {
      headers: { 'Authorization': `Bearer ${token}` }
    });

    if (mode === 'webcam') axios.post('http://127.0.0.1:8000/stop_webcam', {}, {
      headers: { 'Authorization': `Bearer ${token}` }
    });
  };

  const handleLogout = () => {
    localStorage.removeItem('token');
    setToken(null);
    stopMonitoring();
  };

  const EmergencyParticles = () => (
    <div className="fixed inset-0 pointer-events-none z-[55] overflow-hidden">
      {[...Array(20)].map((_, i) => (
        <motion.div
          key={i}
          initial={{ 
            x: Math.random() * window.innerWidth, 
            y: Math.random() * window.innerHeight,
            opacity: 0,
            scale: 0
          }}
          animate={{ 
            y: [null, Math.random() * -100 - 50],
            opacity: [0, 0.8, 0],
            scale: [0, 1, 0],
            x: [null, (Math.random() - 0.5) * 100]
          }}
          transition={{ 
            duration: Math.random() * 2 + 1, 
            repeat: Infinity,
            delay: Math.random() * 2
          }}
          className="absolute w-1 h-1 bg-accent rounded-full shadow-[0_0_10px_#FF4B2B]"
        />
      ))}
    </div>
  );

  if (!token) {
    return <Auth onAuthSuccess={(newToken) => setToken(newToken)} />;
  }

  return (
    <div className="min-h-screen custom-scrollbar bg-primary-deep text-white">
      {/* Alert Overlay Flash & Vignette */}
      <AnimatePresence>
        {drowningDetected && (
          <>
            <motion.div 
              initial={{ opacity: 0 }}
              animate={{ opacity: [0, 0.4, 0] }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.4, repeat: Infinity }}
              className="fixed inset-0 bg-red-600/30 pointer-events-none z-[60]"
            />
            <div className="vignette-active" />
            <EmergencyParticles />
          </>
        )}
      </AnimatePresence>

      {/* Email Sent Popup */}
      <AnimatePresence>
        {showEmailPopup && (
          <motion.div 
            initial={{ opacity: 0, y: 50, scale: 0.9 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, scale: 0.9 }}
            className="fixed bottom-10 right-10 z-[100] glass-card p-6 border-primary/50 shadow-[0_0_30px_rgba(0,209,255,0.3)] max-w-xs"
          >
            <div className="flex items-start gap-4">
              <div className="p-3 bg-primary/20 rounded-xl">
                <Mail className="text-primary" size={24} />
              </div>
              <div>
                <h4 className="font-bold text-white mb-1">Email Alert Sent</h4>
                <p className="text-xs text-white/60 leading-relaxed">Emergency notifications have been successfully dispatched to all registered administrators.</p>
                <button 
                  onClick={() => setShowEmailPopup(false)}
                  className="mt-4 text-[10px] font-black uppercase tracking-widest text-primary hover:text-white transition-colors"
                >
                  Dismiss
                </button>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Navbar */}
      <nav className="fixed top-0 w-full z-50 glass border-b border-white/10 px-6 py-4">
        <div className="max-w-7xl mx-auto flex justify-between items-center">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 bg-primary/20 rounded-xl flex items-center justify-center border border-primary/30">
              <ShieldAlert className="text-primary" />
            </div>
            <span className="text-xl font-bold tracking-tight gradient-text">DeepRescue AI</span>
          </div>
          <div className="hidden md:flex items-center gap-8 text-sm font-medium text-white/70">
            <button onClick={() => {setMode('image'); stopMonitoring();}} className={`hover:text-primary transition-colors ${mode === 'image' ? 'text-primary' : ''}`}>Image</button>
            <button onClick={() => {setMode('video'); stopMonitoring();}} className={`hover:text-primary transition-colors ${mode === 'video' ? 'text-primary' : ''}`}>Video</button>
          </div>
          <div className="flex items-center gap-4">
             <button 
                onClick={handleLogout}
                className="px-4 py-2 bg-white/5 hover:bg-white/10 border border-white/10 rounded-xl text-xs font-bold uppercase transition-colors"
             >
                Logout
             </button>
             <div className="flex items-center gap-2 px-3 py-1 bg-white/5 rounded-full border border-white/10">
                <span className="text-[10px] font-bold uppercase tracking-widest text-white/50">Analysis Engine Active</span>
             </div>
          </div>
        </div>
      </nav>

      {/* Hero / Header */}
      <div className="pt-32 pb-12 px-6">
        <div className="max-w-7xl mx-auto text-center">
          <motion.h1 
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            className="text-4xl md:text-6xl font-black mb-4"
          >
            Real-Time <span className="gradient-text">Drowning Detection</span>
          </motion.h1>
          <p className="text-white/40 max-w-2xl mx-auto">
            Advanced YOLOv8 deep learning system for aquatic safety monitoring. 
            Process individual images or video files for instant drowning detection.
          </p>
        </div>
      </div>

      {/* Main Dashboard */}
      <main className="max-w-7xl mx-auto px-6 pb-24 grid grid-cols-1 lg:grid-cols-12 gap-8">
        
        {/* Left Col: Controls */}
        <div className="lg:col-span-4 space-y-6">
          <div className="glass-card p-6">
            <h3 className="text-lg font-bold mb-6 flex items-center gap-2">
              <Activity size={18} className="text-primary" /> Control Center
            </h3>
            
            <div className="flex flex-col gap-3">
              <button 
                onClick={() => {setMode('image'); stopMonitoring();}}
                className={`py-4 px-6 rounded-2xl flex items-center gap-4 transition-all ${mode === 'image' ? 'bg-primary/20 border border-primary/50 text-white' : 'bg-white/5 border border-white/5 text-white/40 hover:bg-white/10'}`}
              >
                <Camera size={20} />
                <div className="text-left">
                  <p className="font-bold leading-none">Photo Analysis</p>
                  <p className="text-[10px] opacity-60">Single frame detection</p>
                </div>
              </button>

              <button 
                onClick={() => {setMode('video'); stopMonitoring();}}
                className={`py-4 px-6 rounded-2xl flex items-center gap-4 transition-all ${mode === 'video' ? 'bg-primary/20 border border-primary/50 text-white' : 'bg-white/5 border border-white/5 text-white/40 hover:bg-white/10'}`}
              >
                <Video size={20} />
                <div className="text-left">
                  <p className="font-bold leading-none">Video Stream</p>
                  <p className="text-[10px] opacity-60">Frame-by-frame processing</p>
                </div>
              </button>
            </div>

            {mode !== 'webcam' && (
              <div className="mt-8">
                 <div 
                  onClick={() => fileInputRef.current.click()}
                  className="border-2 border-dashed border-white/10 rounded-2xl p-8 text-center cursor-pointer hover:border-primary/50 transition-colors bg-white/5"
                >
                  <input type="file" ref={fileInputRef} className="hidden" onChange={handleFileChange} accept={mode === 'image' ? "image/*" : "video/*"} />
                  {file ? (
                    <div className="truncate text-sm font-medium text-primary uppercase">{file.name}</div>
                  ) : (
                    <>
                      <Upload className="mx-auto text-white/20 mb-3" size={32} />
                      <p className="text-xs font-bold text-white/40 uppercase tracking-widest">Select {mode} file</p>
                    </>
                  )}
                </div>

                <div className="flex gap-2">
                  <button 
                    disabled={!file || loading || isMonitoring}
                    onClick={startAnalysis}
                    className="flex-1 mt-4 py-4 rounded-xl bg-primary text-primary-deep font-black uppercase text-sm tracking-widest shadow-[0_0_20px_rgba(0,209,255,0.2)] disabled:opacity-30 flex items-center justify-center gap-2"
                  >
                    {loading ? <Loader2 size={18} className="animate-spin" /> : <Play size={18} fill="currentColor" />}
                    {loading ? "Processing..." : `Process ${mode}`}
                  </button>

                  {(file || results) && mode === 'image' && (
                    <button 
                      onClick={stopAnalysis}
                      className="mt-4 px-4 py-4 rounded-xl bg-accent/20 border border-accent/30 text-accent font-black uppercase text-sm hover:bg-accent/30 transition-all"
                      title="Stop / Clear"
                    >
                      <Square size={18} fill="currentColor" />
                    </button>
                  )}
                </div>
              </div>
            )}

            {mode === 'webcam' && (
              <button 
                onClick={toggleWebcam}
                className={`w-full mt-6 py-4 rounded-xl font-black uppercase text-sm tracking-widest flex items-center justify-center gap-2 transition-all ${isMonitoring ? 'bg-accent text-white shadow-[0_0_20px_rgba(255,75,43,0.3)]' : 'bg-primary text-primary-deep'}`}
              >
                {isMonitoring ? <Square size={18} fill="currentColor" /> : <Play size={18} fill="currentColor" />}
                {isMonitoring ? "Stop Monitoring" : "Start Live Feed"}
              </button>
            )}
          </div>

          {/* Alert Status Card */}
          <div className="glass-card p-6 overflow-hidden relative">
            <h3 className="text-lg font-bold mb-4 flex items-center gap-2 text-white/80">Alert Indicators</h3>
            <div className="space-y-4">
              <div className={`relative flex items-center justify-between p-4 rounded-xl border transition-all duration-300 ${drowningDetected ? 'bg-accent/30 border-accent alert-blink shadow-[0_0_30px_rgba(255,75,43,0.4)]' : 'bg-white/5 border-white/10 text-white/30'}`}>
                <div className="flex items-center gap-3">
                  <div className={`p-2 rounded-lg ${drowningDetected ? 'bg-accent text-white beep-active shadow-[0_0_15px_rgba(255,75,43,0.8)]' : 'bg-white/5'}`}>
                    <Bell size={20} />
                  </div>
                  <div className="flex flex-col">
                    <span className="text-xs font-black uppercase tracking-tighter">Audio Alarm</span>
                    {drowningDetected && <span className="text-[10px] font-bold text-accent animate-pulse">EMERGENCY BLINK</span>}
                  </div>
                </div>
                <div className={`w-3 h-3 rounded-full ${drowningDetected ? 'bg-accent shadow-[0_0_10px_#FF4B2B] animate-ping' : 'bg-white/10'}`}></div>
              </div>

              <div className={`flex items-center justify-between p-4 rounded-xl border transition-all duration-300 ${emailStatus === 'sent' ? 'bg-green-500/20 border-green-500 text-white' : drowningDetected ? 'bg-primary/20 border-primary/50 text-white animate-pulse' : 'bg-white/5 border-white/10 text-white/30'}`}>
                <div className="flex items-center gap-3">
                  <div className={`p-2 rounded-lg ${emailStatus === 'sent' ? 'bg-green-500 text-white' : drowningDetected ? 'bg-primary text-white' : 'bg-white/5'}`}>
                    <Mail size={20} />
                  </div>
                  <div className="flex flex-col">
                    <span className="text-xs font-black uppercase tracking-tighter">Email Status</span>
                    {emailStatus === 'sent' ? (
                      <span className="text-[10px] font-bold text-green-400">ALERT DISPATCHED</span>
                    ) : drowningDetected ? (
                      <span className="text-[10px] font-bold text-primary">INITIATING...</span>
                    ) : null}
                  </div>
                </div>
                <div className={`w-3 h-3 rounded-full ${emailStatus === 'sent' ? 'bg-green-500 shadow-[0_0_10px_#10B981]' : drowningDetected ? 'bg-primary animate-pulse' : 'bg-white/10'}`}></div>
              </div>
            </div>
            {drowningDetected && (
              <div className="absolute top-0 right-0 w-32 h-32 bg-accent/30 blur-3xl -z-10 animate-pulse"></div>
            )}
            <div className="mt-4">
              <div className="flex justify-between items-center mb-1">
                <span className="text-[10px] font-bold text-white/40 uppercase">System Integrity</span>
                <span className="text-[10px] font-bold text-primary">STABLE</span>
              </div>
              <div className="threat-meter">
                <div 
                  className={`threat-meter-fill transition-all duration-500 ${drowningDetected ? 'bg-accent shadow-[0_0_10px_#FF4B2B]' : 'bg-primary/40'}`} 
                  style={{ width: drowningDetected ? '100%' : '15%' }}
                ></div>
              </div>
            </div>
          </div>
        </div>

        {/* Right Col: Detection Feed & Results */}
          <div className="lg:col-span-8 flex flex-col gap-8">

            {/* Detection Feed – YOLO-annotated MJPEG stream */}
            <div className="glass-card overflow-hidden flex-1 relative flex flex-col min-h-[500px]">
              <div className="p-4 border-b border-white/10 flex items-center justify-between bg-white/5">
                <div className="flex items-center gap-2">
                  <div className={`w-2 h-2 rounded-full ${isMonitoring ? 'bg-green-400 animate-pulse' : 'bg-primary animate-pulse'}`}></div>
                  <span className="text-xs font-bold uppercase tracking-widest text-primary">Detection Feed</span>
                  {isMonitoring && (
                    <span className="ml-2 text-[10px] font-bold text-green-400 uppercase tracking-widest">● LIVE</span>
                  )}
                </div>
                <div className="flex items-center gap-3 text-[10px] font-bold text-white/40 uppercase">
                  {uploading && <span className="text-yellow-400 animate-pulse">⟳ Uploading...</span>}
                  {isMonitoring && <span className="text-green-400">YOLO Active</span>}
                  <span>MJPEG</span>
                </div>
              </div>

              <div className={`flex-1 bg-black/40 relative flex items-center justify-center overflow-hidden ${drowningDetected ? 'glitch-active' : ''}`}>
                {/* Scanner Line */}
                {drowningDetected && isMonitoring && <div className="scanner-line" />}
                
                {/* Priority: streamUrl > results.image > uploading spinner > preview > idle */}
                {streamUrl ? (
                  <img 
                    key={streamUrl}
                    src={streamUrl} 
                    alt="Detection Stream" 
                    className="w-full h-full object-contain"
                    onLoad={() => console.log("✅ Stream connected")}
                    onError={() => {
                      if (isMonitoring && streamUrl) {
                        const base = streamUrl.split('&retry=')[0];
                        setTimeout(() => setStreamUrl(`${base}&retry=${Date.now()}`), 2000);
                      }
                    }}
                  />
                ) : results?.image ? (
                  <img 
                    src={`data:image/jpeg;base64,${results.image}`} 
                    alt="Inference Result" 
                    className="w-full h-full object-contain"
                  />
                ) : uploading || loading ? (
                  <div className="text-center space-y-4">
                    <div className="w-16 h-16 rounded-full border-4 border-dashed border-primary animate-spin mx-auto shadow-[0_0_15px_rgba(0,209,255,0.4)]"></div>
                    <p className="text-white text-sm font-black tracking-widest uppercase">
                      {uploading ? 'Uploading & Analyzing...' : 'Processing...'}
                    </p>
                  </div>
                ) : preview && mode === 'image' ? (
                  <img src={preview} alt="Upload Preview" className="w-full h-full object-contain opacity-50 blur-sm" />
                ) : (
                  <div className="text-center space-y-4">
                    <div className="w-16 h-16 rounded-full border-4 border-dashed border-white/10 mx-auto"></div>
                    <p className="text-white/30 text-sm font-black tracking-widest uppercase">Awaiting Input</p>
                    <p className="text-white/20 text-xs">Select a video file or webcam to begin</p>
                  </div>
                )}

                {/* Drowning Alert Overlay */}
                <AnimatePresence>
                  {drowningDetected && (
                    <motion.div 
                      initial={{ opacity: 0 }}
                      animate={{ opacity: 1 }}
                      exit={{ opacity: 0 }}
                      className="absolute inset-0 border-[12px] border-accent/40 pointer-events-none animate-pulse z-40"
                    />
                  )}
                </AnimatePresence>

                {/* HUD Corners */}
                <div className="absolute inset-0 pointer-events-none opacity-50">
                  <div className="absolute top-4 left-4 w-8 h-8 border-t-2 border-l-2 border-primary/30"></div>
                  <div className="absolute top-4 right-4 w-8 h-8 border-t-2 border-r-2 border-primary/30"></div>
                  <div className="absolute bottom-4 left-4 w-8 h-8 border-b-2 border-l-2 border-primary/30"></div>
                  <div className="absolute bottom-4 right-4 w-8 h-8 border-b-2 border-r-2 border-primary/30"></div>
                </div>

                {isMonitoring && !drowningDetected && (
                  <div className="absolute bottom-6 left-6 flex items-center gap-2">
                    <div className="w-2 h-2 rounded-full bg-green-500 animate-pulse"></div>
                    <span className="text-[10px] font-mono text-green-500 uppercase tracking-widest">Scanning Environment...</span>
                  </div>
                )}

                {/* Live detection badges overlay */}
                {isMonitoring && results?.detections && results.detections.length > 0 && (
                  <div className="absolute top-4 left-4 flex flex-col gap-1 z-30">
                    {results.detections.slice(0, 5).map((d, i) => (
                      <div key={i} className={`px-2 py-1 rounded text-[10px] font-bold uppercase flex items-center gap-1 ${d.class === 'drowning' ? 'bg-accent/80 text-white' : 'bg-primary/70 text-white'}`}>
                        <span>{d.class}</span>
                        <span className="opacity-75">{(d.confidence * 100).toFixed(0)}%</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* Bottom Status Bar */}
              {isMonitoring && (
                <div className="p-4 flex justify-center border-t border-white/10">
                  <button 
                    onClick={stopMonitoring}
                    className="px-8 py-3 rounded-xl glass border border-accent/30 text-accent font-bold text-xs uppercase hover:bg-accent/10 transition-colors"
                  >
                    Stop Monitoring Feed
                  </button>
                </div>
              )}
            </div>

            {/* Detections List */}
            {results?.detections && (
               <div className="glass-card p-6">
                  <h3 className="text-sm font-bold text-white/40 uppercase mb-4 tracking-widest">Detection History</h3>
                  <div className="flex flex-wrap gap-3">
                    {results.detections.map((d, i) => (
                      <div key={i} className="px-4 py-2 rounded-lg bg-white/5 border border-white/5 flex items-center gap-3">
                        <div className="w-2 h-2 rounded-full bg-primary"></div>
                        <span className="text-sm font-bold uppercase">{d.class}</span>
                        <span className="text-xs text-primary font-mono bg-primary/10 px-1.5 rounded">{(d.confidence * 100).toFixed(0)}%</span>
                      </div>
                    ))}
                  </div>
               </div>
            )}
          </div>

      </main>

      {/* Technology Section */}
      <section id="tech" className="py-24 px-6 relative overflow-hidden">
        <div className="absolute top-0 left-1/2 -translate-x-1/2 w-full h-px bg-gradient-to-r from-transparent via-primary/30 to-transparent"></div>
        <div className="max-w-7xl mx-auto">
          <div className="text-center mb-16">
            <h2 className="text-3xl md:text-5xl font-bold mb-4">The Science Behind <span className="gradient-text">DeepRescue</span></h2>
            <p className="text-white/40 max-w-2xl mx-auto italic">Our system leverages state-of-the-art architectures to ensure split-second accuracy in life-critical situations.</p>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-8">
            {[
              { 
                name: 'YOLOv8 Engine', 
                desc: 'Utilizing You Only Look Once v8 for ultra-fast, real-time object detection. The model is fine-tuned on specialized aquatic datasets to recognize distress patterns and person positions with extreme precision.',
                icon: <Cpu className="text-primary" size={32} />
              },
              { 
                name: 'FastAPI Backend', 
                desc: 'A high-performance Python framework powering our asynchronous inference engine. It handles frame-by-frame MJPEG streaming and manages concurrent webcam connections with minimal latency.',
                icon: <Zap className="text-primary" size={32} />
              },
              { 
                name: 'OpenCV Vision', 
                desc: 'Industrial-grade computer vision library used for real-time video capture, frame manipulation, and digital annotation. It ensures smooth hardware acceleration for both webcam and file streams.',
                icon: <Camera className="text-primary" size={32} />
              },
              { 
                name: 'Deep Learning', 
                desc: 'Neural networks trained on thousands of drowning and swimming scenarios. The system uses complex heatmaps and motion analysis to differentiate between normal splashing and genuine emergency signals.',
                icon: <ShieldAlert className="text-primary" size={32} />
              }
            ].map((tech, i) => (
              <motion.div 
                key={i}
                whileHover={{ y: -10 }}
                className="glass-card p-8 border-white/5 hover:border-primary/20 transition-all group"
              >
                <div className="mb-6 p-4 bg-primary/10 rounded-2xl w-fit group-hover:bg-primary/20 transition-colors">
                  {tech.icon}
                </div>
                <h3 className="text-xl font-bold mb-4">{tech.name}</h3>
                <p className="text-white/50 text-sm leading-relaxed">{tech.desc}</p>
              </motion.div>
            ))}
          </div>
          
          <div className="mt-16 p-8 glass-card border-dashed border-primary/20 text-center">
            <p className="text-white/60 text-sm">
              <span className="text-primary font-bold">Architecture Note:</span> DeepRescue V2.0 implements a modular design where the frontend communicates via persistent WebSockets and MJPEG buffers, ensuring that monitoring never stops even during peak network fluctuations.
            </p>
          </div>
        </div>
      </section>

      <footer className="py-20 px-6 border-t border-white/5 relative overflow-hidden">
        <div className="absolute inset-0 bg-primary/2 -z-10"></div>
        <div className="max-w-7xl mx-auto">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-12 mb-16">
            <div className="space-y-6">
               <div className="flex items-center gap-3">
                <div className="w-8 h-8 bg-primary/20 rounded-lg flex items-center justify-center border border-primary/30">
                  <ShieldAlert className="text-primary" size={16} />
                </div>
                <span className="text-xl font-black tracking-tighter gradient-text">DeepRescue AI</span>
              </div>
              <p className="text-white/40 text-sm leading-relaxed italic">
                Protecting aquatic environments through the power of intelligent vision. Our mission is to eliminate drowning incidents in public and private pools globally.
              </p>
            </div>
            
            <div className="space-y-4 text-center md:text-left">
              <h4 className="font-bold text-white/60 text-xs uppercase tracking-widest">Quick Navigation</h4>
              <div className="flex flex-col gap-2 text-sm text-white/30">
                <a href="#home" className="hover:text-primary transition-colors">Safety Dashboard</a>
                <a href="#tech" className="hover:text-primary transition-colors">Neural Architecture</a>
                <a href="#" className="hover:text-primary transition-colors">Emergency Protocol</a>
              </div>
            </div>

            <div className="space-y-4 text-center md:text-right">
              <h4 className="font-bold text-white/60 text-xs uppercase tracking-widest">Connect</h4>
              <div className="flex justify-center md:justify-end gap-6">
                <Github size={20} className="text-white/20 hover:text-white cursor-pointer transition-colors" />
                <Mail size={20} className="text-white/20 hover:text-white cursor-pointer transition-colors" />
                <ShieldAlert size={20} className="text-white/20 hover:text-white cursor-pointer transition-colors" />
              </div>
              <p className="text-[10px] text-white/20 font-bold uppercase tracking-widest pt-4">© 2026 Emergency AI Labs</p>
            </div>
          </div>
          
          <div className="pt-8 border-t border-white/5 text-center">
             <p className="text-sm font-medium text-white/40 mb-2">Developed for excellence in AI-based water safety monitoring and real-time distress prevention.</p>
             <h2 className="text-xl font-black tracking-[0.3em] uppercase opacity-20 hover:opacity-100 transition-opacity duration-700 cursor-default">
               Designed by DeepRescue System
             </h2>
          </div>
        </div>
      </footer>
    </div>
  );
};

export default App;
