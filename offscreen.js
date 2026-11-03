/**
 * Offscreen document for parsing HTML in service worker context.
 * Receives HTML via message passing, parses it using parse-usage.js,
 * and sends results back to the service worker.
 */

import { parseUsageHtml } from './parse-usage.js';

// Listen for messages from the service worker
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'PARSE_USAGE_HTML') {
    try {
      const result = parseUsageHtml(message.html);
      sendResponse({ success: true, data: result });
    } catch (error) {
      console.error('[offscreen] Parse error:', error);
      sendResponse({ success: false, error: error.message });
    }
    return true; // Keep message channel open for async response
  }
});

// Signal that offscreen document is ready
console.log('[offscreen] Ready for parsing');