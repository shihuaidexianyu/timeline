/*
 * When the self-hosted dashboard is opened on loopback, tell the background
 * worker which origin is currently serving the agent so browser events can
 * follow custom local ports without hardcoded coupling.
 */

if (['127.0.0.1', 'localhost', '[::1]'].includes(window.location.hostname)) {
  chrome.runtime.sendMessage({
    type: 'timeline-discover-agent',
    origin: window.location.origin,
  })
}
