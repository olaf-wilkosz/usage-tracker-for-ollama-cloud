// The parser needs a DOMParser (the extension runs it in an offscreen document); in Node
// jsdom provides one.
import { JSDOM } from 'jsdom';

globalThis.DOMParser = new JSDOM('').window.DOMParser;
