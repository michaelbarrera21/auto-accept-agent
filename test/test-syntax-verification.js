
try {
    const cdp = require('./main_scripts/cdp-handler.js');
    console.log('Successfully required cdp-handler.js');
} catch (e) {
    console.error('Error requiring cdp-handler.js:', e);
}
