# Package Install Buttons Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add per-node "Install" buttons to the iSCSI and Multipath tabs, and an inline sanlock prompt before the "Add LVM Storage" dialog.

**Architecture:** New `POST /nodes/{node}/iscsi/install` endpoint runs `apt-get install` as a fork_worker task. The iSCSI and Multipath panels each call the status endpoint on load and conditionally show install buttons. The "Add LVM Storage" handler checks for sanlock before opening the dialog.

**Tech Stack:** Perl (PVE::RESTHandler, PVE::RPCEnvironment), ExtJS 6 (Proxmox.Utils.API2Request), existing `check_package_installed` / `fork_worker` patterns.

---

## Context for implementer

### Project layout
- Backend: `src/perl/PVE/API2/ISCSIMultipath.pm` — all REST endpoints
- Frontend: `src/js/pve-iscsi-multipath.js` — all ExtJS panels
- Tests: `t/*.t` — Perl unit tests only (no JS tests)
- Build: `make deb` → `pve-iscsi-multipath_0.2.0_all.deb`
- Deploy: `dpkg -i /tmp/pve-iscsi-multipath_0.2.0_all.deb` on each node

### Key Perl patterns
```perl
# Registering an endpoint
__PACKAGE__->register_method({
    name    => 'my_endpoint',
    path    => 'my-path',
    method  => 'POST',
    protected   => 1,
    proxyto     => 'node',
    permissions => { check => ['perm', '/nodes/{node}', ['Sys.Modify']] },
    parameters  => {
        additionalProperties => 0,
        properties => {
            node    => get_standard_option('pve-node'),
            package => { type => 'string', enum => ['open-iscsi', 'multipath-tools', 'sanlock'] },
        },
    },
    returns => { type => 'string' },   # UPID
    code => sub {
        my ($param) = @_;
        my $rpcenv  = PVE::RPCEnvironment::get();
        my $authuser = $rpcenv->get_user();
        return $rpcenv->fork_worker('workertype', undef, $authuser, sub {
            # work here — print goes to task log
        });
    },
});
```

### apt-get eval+check pattern (already used in setup endpoint)
```perl
eval { _run_cmd(['apt-get', 'install', '-y', $pkg]) };
if ($@) {
    die "Installation failed: $@\n" unless check_package_installed($pkg);
    warn "apt-get reported errors but $pkg installed successfully\n";
}
```

### Key JS patterns
```javascript
// API call
Proxmox.Utils.API2Request({
    url: '/nodes/' + nodename + '/iscsi/status',
    method: 'GET',
    success: function (response) { var d = response.result.data; ... },
    failure: function (r) { Ext.Msg.alert(gettext('Error'), r.htmlStatus); },
});

// Show/hide a toolbar button by itemId
me.down('#myBtnId').setVisible(true);

// Task polling — call endpoint, get UPID string back, poll until stopped
function pollTask(node, upid, onDone) {
    var interval = setInterval(function () {
        Proxmox.Utils.API2Request({
            url: '/nodes/' + node + '/tasks/' + encodeURIComponent(upid) + '/status',
            method: 'GET',
            success: function (r) {
                if (r.result.data.status === 'stopped') {
                    clearInterval(interval);
                    onDone(r.result.data.exitstatus);
                }
            },
        });
    }, 2000);
}
```

### Where to add the install endpoint in ISCSIMultipath.pm
Insert the new `install` endpoint between `lvm_scan` (ends ~line 925) and `setup` (~line 927). Follow the exact `register_method` pattern of the adjacent endpoints.

### iSCSI panel structure (PVE.node.ISCSIPanel, starts ~line 130)
- `initComponent` sets up `portalsStore`, `sessionsStore`, `portalsGrid`, `sessionsGrid`
- `Ext.apply(me, { items: [portalsGrid, sessionsGrid] })` at ~line 544
- `reloadSessions()` called at end of `initComponent`
- The panel does NOT currently call the status endpoint — we need to add that

### Multipath panel structure (PVE.node.MultipathPanel, starts ~line 553)
- `statusStore` is a proxmox store that auto-loads from `multipath/status`
- `reload = function () { statusStore.load(); }` at ~line 572
- Grid tbar has Reload, Edit Config, Restart multipathd buttons (~line 612)
- `reload()` called at end of `initComponent`
- The panel does NOT currently call the iscsi/status endpoint — we need to add that

### Add LVM Storage button handler (~line 504)
- Gets WWID via `multipath/wwid`, then calls `showAddLvmDialog(alias)`
- We need to intercept before `showAddLvmDialog` to check sanlock

---

## Task 1: Add `install` endpoint to Perl backend

**Files:**
- Modify: `src/perl/PVE/API2/ISCSIMultipath.pm` (between lvm_scan ~line 925 and setup ~line 927)
- Test: `t/02-status.t` (add a test that `check_package_installed` is callable — or skip if already covered)

**Step 1: Write the test first**

Add to `t/02-status.t` after the existing tests:

```perl
# install endpoint helper — check_package_installed already tested in parse/status tests
# Verify the install endpoint is registered in the API tree
ok(PVE::API2::ISCSIMultipath->can('install') ||
   PVE::API2::ISCSIMultipath->get_method('install'),
   'install endpoint registered');
```

Wait — PVE::RESTHandler uses `register_method`, not a plain method. The test framework in this project mocks the RESTHandler. Check `t/lib/PVE/RESTHandler.pm` to see if `get_method` works in tests. If not, skip this test and just verify with a manual API call after deploy.

Actually, the simplest verifiable test: the endpoint exists in the registered methods list. But since the mock RESTHandler may not support `get_method`, skip the unit test and rely on integration testing (deploy + curl). Move directly to implementation.

**Step 2: Add the endpoint**

In `src/perl/PVE/API2/ISCSIMultipath.pm`, insert after the closing `});` of `lvm_scan` (~line 925) and before `__PACKAGE__->register_method({ name => 'setup'`:

```perl
__PACKAGE__->register_method({
    name        => 'install_package',
    path        => 'install',
    method      => 'POST',
    protected   => 1,
    proxyto     => 'node',
    description => 'Install a prerequisite package on this node.',
    permissions => { check => ['perm', '/nodes/{node}', ['Sys.Modify']] },
    parameters  => {
        additionalProperties => 0,
        properties => {
            node    => get_standard_option('pve-node'),
            package => {
                type        => 'string',
                description => 'Package to install',
                enum        => ['open-iscsi', 'multipath-tools', 'sanlock'],
            },
        },
    },
    returns => { type => 'string', description => 'Task UPID' },
    code => sub {
        my ($param) = @_;
        my $rpcenv   = PVE::RPCEnvironment::get();
        my $authuser = $rpcenv->get_user();
        my $pkg      = $param->{package};

        return $rpcenv->fork_worker('iscsipkginstall', undef, $authuser, sub {
            print "Installing $pkg...\n";
            if (check_package_installed($pkg)) {
                print "$pkg is already installed — skipped.\n";
                return;
            }
            eval { _run_cmd(['apt-get', 'install', '-y', $pkg]) };
            if ($@) {
                die "Installation failed: $@\n"
                    unless check_package_installed($pkg);
                warn "apt-get reported errors but $pkg installed successfully\n";
            }
            print "$pkg installed successfully.\n";
        });
    },
});
```

**Step 3: Run tests**

```bash
cd /home/jpolansky/proxmox-storage-plugin && prove -v t/ 2>&1 | tail -5
```

Expected: `All tests successful. Files=5, Tests=55`

**Step 4: Commit**

```bash
git add src/perl/PVE/API2/ISCSIMultipath.pm
git commit -m "feat: add install endpoint for per-package prerequisite installation"
```

---

## Task 2: Add pollTask helper and "Install open-iscsi" button to iSCSI panel

**Files:**
- Modify: `src/js/pve-iscsi-multipath.js`
  - Add `pollTask` helper near top of `PVE.node.ISCSIPanel.initComponent` (~line 139)
  - Add status check + install button to iSCSI panel

**Step 1: Read the current iSCSI panel tbar**

The iSCSI panel uses `portalsGrid` and `sessionsGrid` as items. Neither grid currently checks package status. We need to:
1. Add a `pollTask` helper function in scope
2. Add an `installOpenIscsiBtn` to the portals grid tbar (it's the "primary" toolbar for this panel)
3. After `me.callParent()` and `reloadSessions()`, call the status endpoint and conditionally show the button

**Step 2: Add pollTask helper and install button**

In `PVE.node.ISCSIPanel.initComponent`, after `var reloadSessions = function () { sessionsStore.load(); };` (~line 166), add:

```javascript
var pollTask = function (upid, onDone) {
    var interval = setInterval(function () {
        Proxmox.Utils.API2Request({
            url: '/nodes/' + nodename + '/tasks/' + encodeURIComponent(upid) + '/status',
            method: 'GET',
            success: function (r) {
                if (r.result.data.status === 'stopped') {
                    clearInterval(interval);
                    onDone(r.result.data.exitstatus);
                }
            },
        });
    }, 2000);
};

var runInstall = function (pkg, onSuccess) {
    Proxmox.Utils.API2Request({
        url: '/nodes/' + nodename + '/iscsi/install',
        method: 'POST',
        params: { package: pkg },
        success: function (r) {
            var upid = r.result.data;
            pollTask(upid, function (exitstatus) {
                if (exitstatus === 'OK') {
                    onSuccess();
                } else {
                    Ext.Msg.alert(gettext('Error'),
                        Ext.String.format(gettext('Installation of {0} failed.'), pkg));
                }
            });
        },
        failure: function (r) {
            Ext.Msg.alert(gettext('Error'), r.htmlStatus);
        },
    });
};
```

Then add the install button to `portalsGrid`'s `tbar`. Find the portalsGrid definition (~line 170) and add to its `tbar` array (after existing buttons):

```javascript
{
    text: gettext('Install open-iscsi'),
    iconCls: 'fa fa-download',
    itemId: 'installOpenIscsiBtn',
    hidden: true,
    handler: function () {
        var btn = portalsGrid.down('#installOpenIscsiBtn');
        btn.setDisabled(true);
        btn.setText(gettext('Installing...'));
        runInstall('open-iscsi', function () {
            btn.setVisible(false);
            reloadSessions();
        });
    },
},
```

**Step 3: Check status on panel load and show/hide the button**

After `me.callParent(); reloadSessions();` at the end of `initComponent` (~line 548), add:

```javascript
Proxmox.Utils.API2Request({
    url: '/nodes/' + nodename + '/iscsi/status',
    method: 'GET',
    success: function (r) {
        var d = r.result.data;
        if (!d.packages.open_iscsi) {
            portalsGrid.down('#installOpenIscsiBtn').setVisible(true);
        }
    },
});
```

**Step 4: Run tests (Perl suite unchanged)**

```bash
cd /home/jpolansky/proxmox-storage-plugin && prove -v t/ 2>&1 | tail -3
```

Expected: `All tests successful.`

**Step 5: Commit**

```bash
git add src/js/pve-iscsi-multipath.js
git commit -m "feat: add Install open-iscsi button to iSCSI panel toolbar"
```

---

## Task 3: Add "Install multipath-tools" button to Multipath panel

**Files:**
- Modify: `src/js/pve-iscsi-multipath.js` — `PVE.node.MultipathPanel.initComponent` (~line 559)

**Step 1: Add pollTask helper, install button, and status check**

In `PVE.node.MultipathPanel.initComponent`, after `var reload = function () { statusStore.load(); };` (~line 572), add the same `pollTask` and `runInstall` helpers (copy from iSCSI panel — they're identical in structure, just scoped to a different `nodename`):

```javascript
var pollTask = function (upid, onDone) {
    var interval = setInterval(function () {
        Proxmox.Utils.API2Request({
            url: '/nodes/' + nodename + '/tasks/' + encodeURIComponent(upid) + '/status',
            method: 'GET',
            success: function (r) {
                if (r.result.data.status === 'stopped') {
                    clearInterval(interval);
                    onDone(r.result.data.exitstatus);
                }
            },
        });
    }, 2000);
};

var runInstall = function (pkg, onSuccess) {
    Proxmox.Utils.API2Request({
        url: '/nodes/' + nodename + '/iscsi/install',
        method: 'POST',
        params: { package: pkg },
        success: function (r) {
            var upid = r.result.data;
            pollTask(upid, function (exitstatus) {
                if (exitstatus === 'OK') {
                    onSuccess();
                } else {
                    Ext.Msg.alert(gettext('Error'),
                        Ext.String.format(gettext('Installation of {0} failed.'), pkg));
                }
            });
        },
        failure: function (r) {
            Ext.Msg.alert(gettext('Error'), r.htmlStatus);
        },
    });
};
```

Add the install button to the grid's `tbar` array (after Restart multipathd button, ~line 638):

```javascript
{
    text: gettext('Install multipath-tools'),
    iconCls: 'fa fa-download',
    itemId: 'installMultipathBtn',
    hidden: true,
    handler: function () {
        var btn = me.down('#installMultipathBtn');
        btn.setDisabled(true);
        btn.setText(gettext('Installing...'));
        runInstall('multipath-tools', function () {
            btn.setVisible(false);
            reload();
        });
    },
},
```

After `me.callParent(); reload();` at end of `initComponent` (~line 644), add:

```javascript
Proxmox.Utils.API2Request({
    url: '/nodes/' + nodename + '/iscsi/status',
    method: 'GET',
    success: function (r) {
        var d = r.result.data;
        if (!d.packages.multipath_tools) {
            me.down('#installMultipathBtn').setVisible(true);
        }
    },
});
```

**Step 2: Run tests**

```bash
cd /home/jpolansky/proxmox-storage-plugin && prove -v t/ 2>&1 | tail -3
```

Expected: `All tests successful.`

**Step 3: Commit**

```bash
git add src/js/pve-iscsi-multipath.js
git commit -m "feat: add Install multipath-tools button to Multipath panel toolbar"
```

---

## Task 4: Add inline sanlock prompt to "Add LVM Storage" handler

**Files:**
- Modify: `src/js/pve-iscsi-multipath.js` — the `iscsiAddLvmBtn` handler (~line 504)

**Step 1: Understand current handler flow**

Currently at ~line 504:
1. Get selected session's `target_iqn` and `portal`
2. Call `multipath/wwid` to get alias
3. Call `showAddLvmDialog(alias)`

We need to intercept step 3: before calling `showAddLvmDialog`, check if sanlock is installed. If not, prompt.

**Step 2: Wrap the `showAddLvmDialog` call with a sanlock check**

Replace the `showAddLvmDialog(alias)` call inside the `multipath/wwid` success callback with:

```javascript
// Check sanlock before opening LVM dialog
Proxmox.Utils.API2Request({
    url: '/nodes/' + nodename + '/iscsi/status',
    method: 'GET',
    success: function (statusResp) {
        var pkgs = statusResp.result.data.packages;
        if (pkgs.sanlock) {
            showAddLvmDialog(alias);
        } else {
            Ext.Msg.show({
                title: gettext('Install sanlock?'),
                icon: Ext.Msg.QUESTION,
                message: gettext('sanlock is not installed. It is required for ' +
                    'clustered LVM locking across nodes. ' +
                    'Would you like to install it now?'),
                buttons: Ext.Msg.YESNOCANCEL,
                buttonText: {
                    yes: gettext('Install & Continue'),
                    no:  gettext('Skip'),
                },
                fn: function (btn) {
                    if (btn === 'cancel') return;
                    if (btn === 'no') {
                        showAddLvmDialog(alias);
                        return;
                    }
                    // btn === 'yes' — install sanlock then open dialog
                    Proxmox.Utils.API2Request({
                        url: '/nodes/' + nodename + '/iscsi/install',
                        method: 'POST',
                        params: { package: 'sanlock' },
                        waitMsgTarget: me,
                        success: function (installResp) {
                            var upid = installResp.result.data;
                            var interval = setInterval(function () {
                                Proxmox.Utils.API2Request({
                                    url: '/nodes/' + nodename + '/tasks/' +
                                         encodeURIComponent(upid) + '/status',
                                    method: 'GET',
                                    success: function (r) {
                                        if (r.result.data.status === 'stopped') {
                                            clearInterval(interval);
                                            if (r.result.data.exitstatus === 'OK') {
                                                showAddLvmDialog(alias);
                                            } else {
                                                Ext.Msg.alert(gettext('Error'),
                                                    gettext('sanlock installation failed.'));
                                            }
                                        }
                                    },
                                });
                            }, 2000);
                        },
                        failure: function (r) {
                            Ext.Msg.alert(gettext('Error'), r.htmlStatus);
                        },
                    });
                },
            });
        }
    },
    failure: function () {
        // Status check failed — proceed without sanlock check
        showAddLvmDialog(alias);
    },
});
```

Note: `Ext.Msg.YESNOCANCEL` with custom `buttonText` is standard ExtJS 6. The `fn` callback receives `'yes'`, `'no'`, or `'cancel'`.

**Step 3: Run tests**

```bash
cd /home/jpolansky/proxmox-storage-plugin && prove -v t/ 2>&1 | tail -3
```

Expected: `All tests successful.`

**Step 4: Commit**

```bash
git add src/js/pve-iscsi-multipath.js
git commit -m "feat: prompt to install sanlock before Add LVM Storage dialog"
```

---

## Task 5: Build, deploy, and smoke-test

**Step 1: Build**

```bash
cd /home/jpolansky/proxmox-storage-plugin
prove -v t/ 2>&1 | tail -3    # must show All tests successful
make deb 2>&1 | tail -3
```

Expected last line: `rm -rf debian/tmp`

**Step 2: Deploy to all nodes**

```bash
for h in 192.168.121.21 192.168.121.22 192.168.121.23; do
  scp pve-iscsi-multipath_0.2.0_all.deb root@$h:/tmp/ && \
  ssh root@$h 'dpkg -i /tmp/pve-iscsi-multipath_0.2.0_all.deb 2>&1 | grep "Setting up"'
done
```

Expected: `Setting up pve-iscsi-multipath (0.2.0) ...` for each node.

**Step 3: Verify endpoint exists via API**

```bash
ssh root@192.168.121.21 'pvesh ls /nodes/cclabhost21/iscsi'
```

Expected: output includes `install` in the list of paths.

**Step 4: Commit if any last-minute changes were needed**

If no changes needed, just confirm all good.
