// An in-memory stand-in for '@supabase/supabase-js'.
//
// Test files install it with:
//   vi.mock('@supabase/supabase-js', () => import('../helpers/supabase-mock.js'));
// and drive it through configureSupabaseMock() / getSupabaseCalls().
//
// The api/ handlers create their clients at module scope, so the same two
// client objects are reused across a file; resetSupabaseMock() in a
// beforeEach clears the state between tests.

const state = {
  authUser: undefined,   // user returned by anon auth.getUser; null => bad token
  results: {},           // '<table>.<op>' | 'auth.admin.<fn>' -> result | result[] | fn(call)
  calls: [],             // every operation, in order
};

export const TEACHER_ID = 'teacher-1';
export const OTHER_TEACHER_ID = 'teacher-2';

export const TEACHER_USER = Object.freeze({
  id: 'teacher-uid',
  email: 'teacher@example.com',
  app_metadata: { role: 'teacher', teacher_id: TEACHER_ID },
});

export const ASSISTANT_USER = Object.freeze({
  id: 'assistant-uid',
  email: 'assistant@example.com',
  app_metadata: { role: 'assistant', teacher_id: TEACHER_ID },
});

export const OWNER_USER = Object.freeze({
  id: 'owner-uid',
  email: 'owner@lumen.education',
  app_metadata: { role: 'owner' },
});

export const STUDENT_USER = Object.freeze({
  id: 'student-uid',
  email: 'student@example.com',
  app_metadata: { role: 'student', teacher_id: TEACHER_ID },
});

// The profile rows authenticate() reads back for each of those users.
export const PROFILES = {
  'teacher-uid':   { id: 'teacher-uid',   teacher_id: TEACHER_ID, role: 'teacher',   full_name: 'A Teacher',   is_active: true },
  'assistant-uid': { id: 'assistant-uid', teacher_id: TEACHER_ID, role: 'assistant', full_name: 'An Assistant', is_active: true, staff_perms: ['students'] },
  'owner-uid':     { id: 'owner-uid',     teacher_id: null,       role: 'owner',     full_name: 'Lumen Staff', is_active: true },
  'student-uid':   { id: 'student-uid',   teacher_id: TEACHER_ID, role: 'student',   full_name: 'A Student',   is_active: true },
};

export function configureSupabaseMock({ authUser, results } = {}) {
  if (authUser !== undefined) state.authUser = authUser;
  if (results) Object.assign(state.results, results);
}

export function resetSupabaseMock() {
  state.authUser = TEACHER_USER;
  state.results = {};
  state.calls = [];
}

export function getSupabaseCalls(filter) {
  if (!filter) return [...state.calls];
  return state.calls.filter(c => `${c.table}.${c.op}` === filter || c.op === filter);
}

resetSupabaseMock();

// A configured result may be a value, a queue of values (consumed in
// order, the last one repeating), or a function of the call.
function resolveResult(key, call, fallback) {
  let r = state.results[key];
  if (Array.isArray(r) && !('data' in r)) r = r.length > 1 ? state.results[key].shift() : r[0];
  if (typeof r === 'function') r = r(call);
  return r === undefined ? fallback : r;
}

class QueryBuilder {
  constructor(table) {
    this.call = { table, op: null, payload: undefined, filters: {}, columns: undefined };
  }
  select(cols, opts) {
    if (!this.call.op) this.call.op = 'select';
    this.call.columns = cols;
    if (opts) this.call.opts = opts;
    return this;
  }
  insert(payload) { this.call.op = 'insert'; this.call.payload = payload; return this; }
  upsert(payload, opts) { this.call.op = 'upsert'; this.call.payload = payload; this.call.opts = opts; return this; }
  update(payload) { this.call.op = 'update'; this.call.payload = payload; return this; }
  delete() { this.call.op = 'delete'; return this; }

  eq(col, val)  { this.call.filters[col] = val; return this; }
  neq(col, val) { this.call.filters['neq:' + col] = val; return this; }
  in(col, vals) { this.call.filters['in:' + col] = vals; return this; }
  is(col, val)  { this.call.filters['is:' + col] = val; return this; }
  not(col, op, val) { this.call.filters[`not:${col}:${op}`] = val; return this; }
  gt(col, val)  { this.call.filters['gt:' + col] = val; return this; }
  order() { return this; }
  limit(n) { this.call.limit = n; return this; }
  range() { return this; }
  single()      { this.call.single = true; return this.run(); }
  maybeSingle() { this.call.single = 'maybe'; return this.run(); }

  run() {
    state.calls.push(this.call);
    const key = `${this.call.table}.${this.call.op}`;
    return Promise.resolve(resolveResult(key, this.call, { data: null, error: null, count: 0 }));
  }
  // Awaiting the builder without single()/maybeSingle() runs it too.
  then(onOk, onErr) { return this.run().then(onOk, onErr); }
}

const authAdmin = {
  createUser: (args) => record('auth.admin.createUser', args, { data: { user: { id: 'new-uid' } }, error: null }),
  updateUserById: (id, args) => record('auth.admin.updateUserById', { id, ...args }, { data: {}, error: null }),
  deleteUser: (id) => record('auth.admin.deleteUser', { id }, { data: {}, error: null }),
  listUsers: (args) => record('auth.admin.listUsers', args, { data: { users: [] }, error: null }),
};

function record(key, payload, fallback) {
  const call = { table: 'auth', op: key, payload };
  state.calls.push(call);
  return Promise.resolve(resolveResult(key, call, fallback));
}

export function createClient() {
  return {
    from: (table) => new QueryBuilder(table),
    rpc: (fn, args) => record(`rpc.${fn}`, args, { data: null, error: null }),
    auth: {
      admin: authAdmin,
      getUser: (token) => {
        state.calls.push({ table: 'auth', op: 'auth.getUser', payload: { token } });
        return Promise.resolve(state.authUser
          ? { data: { user: state.authUser }, error: null }
          : { data: { user: null }, error: { message: 'bad token' } });
      },
    },
  };
}
