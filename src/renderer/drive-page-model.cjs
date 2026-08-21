'use strict';

function createDrivePageModel({ pageSize = 250, fetchPage }) {
  if (typeof fetchPage !== 'function') throw new TypeError('fetchPage is required');
  const size = Math.max(1, Math.min(Number(pageSize) || 250, 1000));
  let sequence = 0;
  let filters = {};
  let state = { offset: 0, limit: size, total: 0, drives: [] };

  async function request(offset) {
    const requestSequence = ++sequence;
    const result = await fetchPage({ ...filters, offset, limit: size });
    if (requestSequence !== sequence) return state;
    if (!result?.success) {
      const error = new Error(result?.error ?? 'Failed to load drive page');
      // Preserve the IPC error code (e.g. STALE_DRIVE_DATA) so callers can
      // recover instead of alerting.
      if (result?.code) error.code = result.code;
      throw error;
    }
    state = {
      offset: result.offset ?? offset,
      limit: result.limit ?? size,
      total: result.total ?? 0,
      drives: result.drives ?? [],
    };
    return state;
  }

  return {
    async load(nextFilters = {}) {
      filters = { ...nextFilters };
      return request(0);
    },
    async next() {
      const nextOffset = state.offset + state.limit;
      if (nextOffset >= state.total) return state;
      return request(nextOffset);
    },
    async previous() {
      return request(Math.max(0, state.offset - state.limit));
    },
    current() {
      return state;
    },
  };
}

const api = { createDrivePageModel };
if (typeof module !== 'undefined' && module.exports) module.exports = api;
if (typeof window !== 'undefined') window.DrivePageModel = api;
