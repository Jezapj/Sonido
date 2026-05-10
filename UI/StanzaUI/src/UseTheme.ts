import { useState, useEffect } from 'react';

/**
 * Returns true when the app is in light mode.
 * Watches for changes so components re-render when the user toggles the theme
 * in Settings without needing the theme to be passed through props.
 */
export function useIsLightMode(): boolean {
  const [isLight, setIsLight] = useState(
    () => document.documentElement.getAttribute('data-theme') === 'light',
  );

  useEffect(() => {
    const observer = new MutationObserver(() => {
      setIsLight(document.documentElement.getAttribute('data-theme') === 'light');
    });
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme'],
    });
    return () => observer.disconnect();
  }, []);

  return isLight;
}