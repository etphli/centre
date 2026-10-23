import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { MobileStore } from './data/store';
import './styles.css';
const store = new MobileStore();
const root = document.getElementById('root');
if (!root) throw new Error('Centre could not find its app root.');
createRoot(root).render(<StrictMode><App store={store}/></StrictMode>);
if ('serviceWorker' in navigator && import.meta.env.PROD) {
  void navigator.serviceWorker.register('/iphone/sw.js',{scope:'/iphone/'}).catch(()=>{
    window.dispatchEvent(new CustomEvent('centre-offline-unavailable'));
  });
}
