import React, { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { ShieldAlert, Mail, Lock, Loader2, ArrowRight, UserPlus, LogIn, Sun, Moon } from 'lucide-react';
import axios from 'axios';

const Auth = ({ onAuthSuccess }) => {
  const [isLogin, setIsLogin] = useState(true);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [isDarkMode, setIsDarkMode] = useState(true);

  useEffect(() => {
    document.body.classList.toggle('light-mode', !isDarkMode);
  }, [isDarkMode]);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setLoading(true);
    setError('');

    try {
      if (isLogin) {
        const formData = new FormData();
        formData.append('username', email);
        formData.append('password', password);
        
        const response = await axios.post('http://127.0.0.1:8000/login', formData);
        sessionStorage.setItem('token', response.data.access_token);
        onAuthSuccess(response.data.access_token);
      } else {
        await axios.post('http://127.0.0.1:8000/signup', { email, password });
        setIsLogin(true);
        setError('Signup successful! Please login.');
      }
    } catch (err) {
      setError(err.response?.data?.detail || 'Authentication failed');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className={`min-h-screen flex items-center justify-center px-6 relative overflow-hidden transition-colors duration-300 ${isDarkMode ? 'bg-primary-deep text-white dark-theme' : 'bg-gray-50 text-gray-900 light-theme'}`}>
      
      {/* Theme Toggle Button */}
      <div className="absolute top-6 right-6 z-50">
         <button
            type="button"
            onClick={() => setIsDarkMode(!isDarkMode)}
            className={`p-2 rounded-xl border transition-colors ${isDarkMode ? 'bg-white/5 hover:bg-white/10 border-white/10 text-white' : 'bg-black/5 hover:bg-black/10 border-black/10 text-gray-800'}`}
            title="Toggle Theme"
         >
            {isDarkMode ? <Sun size={20} /> : <Moon size={20} />}
         </button>
      </div>

      {/* Background Decor */}
      <div className="absolute top-[-10%] left-[-10%] w-[40%] h-[40%] bg-primary/10 blur-[120px] rounded-full" />
      <div className="absolute bottom-[-10%] right-[-10%] w-[40%] h-[40%] bg-accent/10 blur-[120px] rounded-full" />

      <motion.div 
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        className="w-full max-w-md glass-card p-8 relative z-10 border-white/10"
      >
        <div className="flex flex-col items-center mb-8">
          <div className="w-16 h-16 bg-primary/20 rounded-2xl flex items-center justify-center border border-primary/30 mb-4 shadow-[0_0_20px_rgba(0,209,255,0.2)]">
            <ShieldAlert size={32} className="text-primary" />
          </div>
          <h1 className="text-2xl font-black gradient-text">DeepRescue AI</h1>
          <p className="text-white/40 text-sm mt-1">{isLogin ? 'Welcome back, Safety Officer' : 'Create an Emergency Account'}</p>
        </div>

        {error && (
            <motion.div 
                initial={{ opacity: 0, scale: 0.95 }}
                animate={{ opacity: 1, scale: 1 }}
                className={`p-4 rounded-xl text-xs font-bold mb-6 text-center border ${error.includes('successful') ? 'bg-green-500/10 border-green-500/50 text-green-500' : 'bg-accent/10 border-accent/50 text-accent'}`}
            >
                {error}
            </motion.div>
        )}

        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-2">
            <label className="text-[10px] font-black uppercase tracking-widest text-white/40 ml-1">Email Address</label>
            <div className="relative">
              <Mail size={18} className="absolute left-4 top-1/2 -translate-y-1/2 text-white/20" />
              <input 
                type="email" 
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="officer@deeprescue.ai"
                className="w-full bg-white/5 border border-white/10 rounded-xl py-4 pl-12 pr-4 text-sm focus:outline-none focus:border-primary/50 transition-colors"
              />
            </div>
          </div>

          <div className="space-y-2">
            <label className="text-[10px] font-black uppercase tracking-widest text-white/40 ml-1">Secure Password</label>
            <div className="relative">
              <Lock size={18} className="absolute left-4 top-1/2 -translate-y-1/2 text-white/20" />
              <input 
                type="password" 
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="••••••••"
                className="w-full bg-white/5 border border-white/10 rounded-xl py-4 pl-12 pr-4 text-sm focus:outline-none focus:border-primary/50 transition-colors"
              />
            </div>
          </div>

          <button 
            type="submit"
            disabled={loading}
            className="w-full py-4 rounded-xl bg-primary text-primary-deep font-black uppercase text-sm tracking-widest shadow-[0_0_30px_rgba(0,209,255,0.3)] hover:scale-[1.02] active:scale-[0.98] transition-all flex items-center justify-center gap-2 group"
          >
            {loading ? <Loader2 className="animate-spin" size={20} /> : (
              <>
                {isLogin ? <LogIn size={18} /> : <UserPlus size={18} />}
                {isLogin ? 'Authorize Session' : 'Register Operator'}
                <ArrowRight size={16} className="group-hover:translate-x-1 transition-transform" />
              </>
            )}
          </button>
        </form>

        <div className="mt-8 text-center">
            <button 
                onClick={() => { setIsLogin(!isLogin); setError(''); }}
                className="text-white/40 text-xs font-medium hover:text-primary transition-colors"
            >
                {isLogin ? "Don't have an account? Request Access" : "Already an operator? Authenticate Session"}
            </button>
        </div>
      </motion.div>

      {/* Footer Info */}
      <div className="absolute bottom-6 left-1/2 -translate-x-1/2 text-[10px] text-white/10 font-black uppercase tracking-[0.2em]">
        Secured by DeepRescue Encryption Protocol v2.4
      </div>
    </div>
  );
};

export default Auth;
