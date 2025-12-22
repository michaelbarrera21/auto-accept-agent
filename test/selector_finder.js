// load into console and click any button. The selector will be output
// Click anywhere to get selector info
document.addEventListener('click', function(e) {
    e.preventDefault();
    e.stopPropagation();
    
    let el = e.target;
    console.log('=== ELEMENT INFO ===');
    console.log('Tag:', el.tagName);
    console.log('ID:', el.id || '(none)');
    console.log('Classes:', el.className || '(none)');
    console.log('Aria-label:', el.getAttribute('aria-label') || '(none)');
    console.log('Text:', el.textContent?.trim().slice(0, 50) || '(none)');
    
    // Build path to root
    let path = [];
    while (el && el !== document.body) {
        let selector = el.tagName.toLowerCase();
        if (el.id) selector += '#' + el.id;
        if (el.className && typeof el.className === 'string') {
            selector += '.' + el.className.split(' ').filter(c => c).join('.');
        }
        path.unshift(selector);
        el = el.parentElement;
    }
    console.log('Path:', path.join(' > '));
    
    // Also check parent button
    const btn = e.target.closest('button');
    if (btn) {
        console.log('--- PARENT BUTTON ---');
        console.log('Button classes:', btn.className);
        console.log('Button aria-label:', btn.getAttribute('aria-label'));
        console.log('Button text:', btn.textContent?.trim().slice(0, 50));
    }
}, true);

console.log('>>> Click on the + button to get its selector <<<');