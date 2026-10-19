// Applied before first paint (loaded in <head>) to avoid a flash of the wrong theme.
// Default is light; "system" follows the OS.
(() => {
    let t = 'light';
    try {
        const saved = localStorage.getItem('sensoriumTheme');
        if (saved === 'dark' || saved === 'system') t = saved;
    } catch (_) { /* storage unavailable: light */ }
    document.documentElement.dataset.theme = t;
})();
