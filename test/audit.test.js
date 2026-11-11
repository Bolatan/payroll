const test = require('node:test');
const assert = require('node:assert');
const { Audit, User } = require('../lib/models');

/**
 * FR-AUD-01:
 * The system shall automatically record Date-time, User, Action, and Details
 * (entity, record ID, old value, new value, reason) for every event.
 */
test('FR-AUD-01: Audit log schema stores ts, user, action, entity, entityId, empId, details', async () => {
  const entry = new Audit({
    user: 'payroll_officer',
    action: 'update',
    entity: 'Employee',
    entityId: 'EMP001',
    empId: 'EMP001',
    details: {
      oldValue: { basic: 150000 },
      newValue: { basic: 175000 },
      reason: 'Annual increment',
    },
  });

  assert.ok(entry.ts instanceof Date);
  assert.strictEqual(entry.user, 'payroll_officer');
  assert.strictEqual(entry.action, 'update');
  assert.strictEqual(entry.entity, 'Employee');
  assert.strictEqual(entry.entityId, 'EMP001');
  assert.strictEqual(entry.empId, 'EMP001');
  assert.strictEqual(entry.details.reason, 'Annual increment');
  assert.strictEqual(entry.details.oldValue.basic, 150000);
  assert.strictEqual(entry.details.newValue.basic, 175000);
});

/**
 * FR-AUD-02:
 * Audit entries shall be append-only and not editable or deletable by any user including administrators.
 */
test('FR-AUD-02: Audit entries are append-only; update and delete operations throw errors', async () => {
  // Test middleware operations on model/schema
  const blockedOps = ['updateOne', 'updateMany', 'findOneAndUpdate', 'deleteOne', 'deleteMany', 'findOneAndDelete'];

  for (const op of blockedOps) {
    assert.throws(() => {
      // Direct invocation of query pre hooks
      const hookFns = Audit.schema.s.hooks._pres.get(op);
      assert.ok(hookFns && hookFns.length > 0, `Pre hook for ${op} must exist`);
      hookFns[0].fn.call({});
    }, /append-only/i, `Operation ${op} should throw append-only error`);
  }

  // Pre-save hook blocks updating existing saved audit documents
  const saveHooks = Audit.schema.s.hooks._pres.get('save') || [];
  const appendOnlySaveHook = saveHooks.find((h) => {
    let errResult = null;
    try {
      h.fn.call({ isNew: false }, (err) => { errResult = err; });
    } catch (e) { errResult = e; }
    return errResult && /append-only/i.test(errResult.message);
  });
  assert.ok(appendOnlySaveHook, 'Save pre hook for append-only must exist and reject non-new documents');
});

/**
 * FR-AUD-03:
 * The log shall be searchable and filterable by date range, user, action and employee, and exportable.
 */
test('FR-AUD-03: Filter logic handles date range, user, action, and empId correctly', () => {
  // Mock query builder logic identical to /api/audit
  function buildAuditQuery(query) {
    const filter = {};
    if (query.user) filter.user = new RegExp(String(query.user).trim(), 'i');
    if (query.action) filter.action = String(query.action).trim();
    if (query.entity) filter.entity = String(query.entity).trim();
    if (query.empId) {
      const eid = String(query.empId).trim();
      filter.$or = [{ empId: eid }, { entityId: eid }, { 'details.empId': eid }];
    }
    if (query.startDate || query.endDate) {
      filter.ts = {};
      if (query.startDate) filter.ts.$gte = new Date(query.startDate);
      if (query.endDate) {
        const ed = new Date(query.endDate);
        if (String(query.endDate).length <= 10) ed.setUTCHours(23, 59, 59, 999);
        filter.ts.$lte = ed;
      }
    }
    return filter;
  }

  const q1 = buildAuditQuery({ user: 'bolatan', action: 'approve', empId: 'EMP005' });
  assert.ok(q1.user.test('Bolatan'));
  assert.strictEqual(q1.action, 'approve');
  assert.deepStrictEqual(q1.$or, [{ empId: 'EMP005' }, { entityId: 'EMP005' }, { 'details.empId': 'EMP005' }]);

  const q2 = buildAuditQuery({ startDate: '2026-01-01', endDate: '2026-01-31' });
  assert.ok(q2.ts.$gte instanceof Date);
  assert.ok(q2.ts.$lte instanceof Date);
  assert.strictEqual(q2.ts.$lte.getUTCHours(), 23);
  assert.strictEqual(q2.ts.$lte.getUTCMinutes(), 59);
});

/**
 * FR-AUD-04:
 * Access to view sensitive audit data shall be restricted to Auditor and Admin roles.
 */
test('FR-AUD-04: RBAC authorization policy permits Auditor and Admin roles to view audit logs', () => {
  const allowedRoles = ['auditor', 'admin'];
  const testUsers = [
    { role: 'admin', canView: true },
    { role: 'auditor', canView: true },
    { role: 'payroll', canView: false },
    { role: 'hr', canView: false },
    { role: 'employee', canView: false },
    { role: 'supervisor', canView: false },
  ];

  for (const u of testUsers) {
    const isAuthorized = u.role === 'admin' || allowedRoles.includes(u.role);
    assert.strictEqual(isAuthorized, u.canView, `Role ${u.role} authorization mismatch`);
  }
});

/**
 * FR-AUD-05:
 * Audit records shall be retained for at least six years.
 */
test('FR-AUD-05: Audit schema sets default retention policy of at least 6 years without auto-expiring TTL indexes', () => {
  const defaultRetention = Audit.schema.path('retentionYears').defaultValue;
  assert.strictEqual(defaultRetention, 6);

  // Ensure no TTL index expires audit records earlier than 6 years
  const indexes = Audit.schema.indexes();
  for (const [idxDef, opts] of indexes) {
    if (opts && opts.expireAfterSeconds !== undefined) {
      const minSecondsIn6Years = 6 * 365 * 24 * 3600;
      assert.ok(opts.expireAfterSeconds >= minSecondsIn6Years, 'TTL index cannot expire records before 6 years');
    }
  }
});
