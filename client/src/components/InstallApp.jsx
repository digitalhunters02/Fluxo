import { useEffect, useState } from 'react';
import { t } from '../i18n.jsx';

let deferred = null;

// "Install app": Chrome/Edge/Android show a real button; iPhone gets the Share -> Add to Home Screen hint.
// Renders nothing when the app is already installed or the browser cannot install it.
export default function InstallApp({ className = '', dark = false }) {
  const [evt, setEvt] = useState(deferred);
  const [installed, setInstalled] = useState(false);

  useEffect(() => {
    const onPrompt = (e) => { e.preventDefault(); deferred = e; setEvt(e); };
    const onInstalled = () => { deferred = null; setEvt(null); setInstalled(true); };
    window.addEventListener('beforeinstallprompt', onPrompt);
    window.addEventListener('appinstalled', onInstalled);
    return () => {
      window.removeEventListener('beforeinstallprompt', onPrompt);
      window.removeEventListener('appinstalled', onInstalled);
    };
  }, []);

  const standalone = window.matchMedia?.('(display-mode: standalone)').matches || window.navigator.standalone;
  if (standalone || installed) return null;
  const ios = /iphone|ipad|ipod/i.test(window.navigator.userAgent);

  if (evt) {
    return (
      <div className={className}>
        <button
          type="button"
          data-testid="install-app"
          className={dark ? 'underline hover:text-white' : 'btn btn-ghost'}
          onClick={async () => {
            evt.prompt();
            await evt.userChoice.catch(() => {});
            deferred = null;
            setEvt(null);
          }}
        >
          {t('Install app')}
        </button>
      </div>
    );
  }
  if (ios) return <p data-testid="install-ios-hint" className={`m-0 text-xs ${dark ? 'text-teal-100' : 'text-slate-500'} ${className}`}>{t('To install: tap the Share button, then “Add to Home Screen”.')}</p>;
  return null;
}
