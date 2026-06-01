/**
 * ui/EventBus.js
 * Lightweight publish/subscribe event bus for UI component communication.
 *
 * Components communicate through events rather than direct references.
 * This keeps screens decoupled — a card resolving in InboxScreen doesn't
 * need to know that DashboardScreen exists; it just emits 'card:resolved'
 * and Dashboard reacts if it's listening.
 *
 * Rules:
 *   - No state imports. Pure event routing.
 *   - All event names use 'namespace:action' format.
 *   - Listeners are cleaned up automatically when a screen unmounts
 *     (screens call EventBus.off with their listener refs in cleanup()).
 *   - One-time listeners use once() — auto-removed after first fire.
 *
 * Standard event catalog (add here as new events are introduced):
 *
 *   Game flow:
 *     'game:tick'             — play revealed, payload: { play, gameIndex }
 *     'game:committed'        — game finalized, payload: { result, gameIndex }
 *     'game:phaseChanged'     — phase transition, payload: { from, to }
 *     'game:weatherChanged'   — weather status updated, payload: { status, frame }
 *
 *   Cards:
 *     'card:delivered'        — new card in inbox, payload: { card }
 *     'card:resolved'         — card decision made, payload: { instanceId, choice }
 *     'card:expired'          — card auto-resolved, payload: { instanceId }
 *
 *   Navigation:
 *     'nav:switchTab'         — request tab change, payload: { tab }
 *     'nav:milestone'         — milestone screen should show, payload: { milestoneId }
 *     'nav:milestoneCleared'  — user dismissed milestone screen
 *
 *   Roster:
 *     'roster:changed'        — any roster mutation committed
 *     'roster:ilReturn'       — player cleared to return, payload: { playerId }
 *
 *   Settings:
 *     'settings:themeChanged' — theme updated, payload: { theme }
 *     'settings:colorChanged' — team color updated, payload: { primary, secondary }
 */

const _listeners = new Map(); // event → Set of handler functions

/**
 * on(event, handler)
 * Subscribe to an event. Returns the handler for later removal.
 *
 * @param {String}   event
 * @param {Function} handler
 * @returns {Function} handler (for use with off())
 */
export function on(event, handler) {
  if (!_listeners.has(event)) _listeners.set(event, new Set());
  _listeners.get(event).add(handler);
  return handler;
}

/**
 * off(event, handler)
 * Unsubscribe a specific handler from an event.
 *
 * @param {String}   event
 * @param {Function} handler  — the reference returned by on()
 */
export function off(event, handler) {
  _listeners.get(event)?.delete(handler);
}

/**
 * once(event, handler)
 * Subscribe to an event for a single firing only.
 * Auto-removes the listener after first call.
 *
 * @param {String}   event
 * @param {Function} handler
 * @returns {Function} wrappedHandler (for early removal via off() if needed)
 */
export function once(event, handler) {
  const wrapped = (payload) => {
    off(event, wrapped);
    handler(payload);
  };
  return on(event, wrapped);
}

/**
 * emit(event, payload?)
 * Fire an event, calling all registered handlers.
 * Handlers receive the payload as their first argument.
 * Errors in individual handlers are caught and logged — one bad
 * handler never silences others.
 *
 * @param {String} event
 * @param {*}      [payload]
 */
export function emit(event, payload) {
  const handlers = _listeners.get(event);
  if (!handlers || handlers.size === 0) return;
  for (const handler of handlers) {
    try {
      handler(payload);
    } catch (err) {
      console.error(`EventBus: handler error on '${event}':`, err);
    }
  }
}

/**
 * clear(event?)
 * Remove all handlers for a specific event, or clear all events if
 * no argument passed. Used for testing and full app resets.
 *
 * @param {String} [event]
 */
export function clear(event) {
  if (event) {
    _listeners.delete(event);
  } else {
    _listeners.clear();
  }
}

/**
 * listenerCount(event)
 * Returns the number of active listeners for an event.
 * Useful for debugging.
 *
 * @param {String} event
 * @returns {Number}
 */
export function listenerCount(event) {
  return _listeners.get(event)?.size ?? 0;
}
