'use strict';

function createDrivePageModel({ pageSize = 3, fetchPage }) {
  if (typeof fetchPage !== 'function') throw new TypeError('fetchPage is required');
  const normalizeSize = (value) => Math.max(1, Math.min(Math.floor(Number(value)) || 3, 1000));
  let size = normalizeSize(pageSize);
  let sequence = 0;
  let filters = {};
  let state = { offset: 0, limit: size, total: 0, drives: [] };

  async function request(offset, driveId) {
    const requestSequence = ++sequence;
    const query = { ...filters, offset, limit: size };
    if (driveId != null) query.driveId = driveId;
    const result = await fetchPage(query);
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
    async refresh() {
      const pending = request(state.offset);
      const refreshSequence = sequence;
      const page = await pending;
      if (refreshSequence !== sequence) return state;
      const lastOffset = Math.max(0, Math.ceil(page.total / size) - 1) * size;
      return page.offset > lastOffset ? request(lastOffset) : page;
    },
    async next() {
      const nextOffset = state.offset + state.limit;
      if (nextOffset >= state.total) return state;
      return request(nextOffset);
    },
    async previous() {
      return request(Math.max(0, state.offset - state.limit));
    },
    async goToPage(pageNumber) {
      const page = Number(pageNumber);
      if (!Number.isFinite(page)) return state;
      const pageCount = Math.max(1, Math.ceil(state.total / size));
      const offset = (Math.max(1, Math.min(Math.floor(page), pageCount)) - 1) * size;
      if (offset === state.offset) {
        ++sequence;
        return state;
      }
      return request(offset);
    },
    async setPageSize(pageSize, anchorDriveId = state.drives[0]?.id) {
      const nextSize = normalizeSize(pageSize);
      if (nextSize === size) return state;
      const previousSize = size;
      size = nextSize;
      if (state.total === 0) {
        ++sequence;
        state = { ...state, offset: 0, limit: size };
        return state;
      }
      const pending = request(Math.floor(state.offset / size) * size, anchorDriveId);
      const resizeSequence = sequence;
      try {
        return await pending;
      } catch (error) {
        if (sequence === resizeSequence) size = previousSize;
        throw error;
      }
    },
    async showDrive(driveId) {
      return request(0, driveId);
    },
    current() {
      return state;
    },
  };
}

const api = { createDrivePageModel };
if (typeof module !== 'undefined' && module.exports) module.exports = api;
if (typeof window !== 'undefined') window.DrivePageModel = api;
