// pve-iscsi-multipath: Proxmox VE iSCSI/Multipath Plugin
// Datacenter storage panel xtype: PVE.dc.StorageView (alias: pveStorageView)
// Nodeinfo class: PVE::API2::Nodes::Nodeinfo starts at line 1 of Nodes.pm

Ext.define('PVE.node.ISCSIPanel', {
    extend: 'Ext.panel.Panel',
    xtype: 'pveNodeISCSIPanel',

    layout: {
        type: 'hbox',
        align: 'stretch',
    },

    initComponent: function () {
        var me = this;
        var nodename = me.pveSelNode.data.node;
        if (!nodename) throw 'no node name specified';

        var portalsStore = Ext.create('Ext.data.Store', {
            fields: ['portal'],
            data: [],
        });

        var sessionsStore = Ext.create('Ext.data.Store', {
            fields: ['target_iqn', 'portal', 'state'],
            proxy: {
                type: 'proxmox',
                url: '/api2/json/nodes/' + nodename + '/iscsi/sessions',
            },
        });

        var reloadSessions = function () {
            sessionsStore.load();
        };

        var portalsGrid = Ext.create('Ext.grid.Panel', {
            title: gettext('Portals'),
            flex: 1,
            store: portalsStore,
            columns: [
                { text: gettext('Portal'), dataIndex: 'portal', flex: 1 },
            ],
            tbar: [
                {
                    text: gettext('Add'),
                    iconCls: 'fa fa-plus',
                    handler: function () {
                        Ext.Msg.prompt(gettext('Add Portal'),
                            gettext('Enter portal IP (e.g. 192.168.1.1 or 192.168.1.1:3260):'),
                            function (btn, value) {
                                if (btn !== 'ok' || !value) return;
                                var portal = value.trim();
                                if (!portal.match(/:/)) portal += ':3260';
                                portalsStore.add({ portal: portal });
                            });
                    },
                },
                {
                    text: gettext('Remove'),
                    iconCls: 'fa fa-trash-o',
                    handler: function () {
                        var sel = portalsGrid.getSelection();
                        if (sel.length) portalsStore.remove(sel);
                    },
                },
                {
                    text: gettext('Discover Targets'),
                    iconCls: 'fa fa-search',
                    handler: function () {
                        var portals = portalsStore.collect('portal').join(',');
                        if (!portals) {
                            Ext.Msg.alert(gettext('Error'), gettext('Add at least one portal first.'));
                            return;
                        }
                        Proxmox.Utils.API2Request({
                            url: '/nodes/' + nodename + '/iscsi/discover',
                            method: 'POST',
                            params: { portals: portals },
                            waitMsgTarget: me,
                            success: function (response) {
                                var targets = response.result.data;
                                if (!targets.length) {
                                    Ext.Msg.alert(gettext('Discovery'), gettext('No targets found.'));
                                    return;
                                }
                                var msg = gettext('Found targets') + ':\n' +
                                    targets.map(t => t.target_iqn + ' (' + t.portal + ')').join('\n');
                                Ext.Msg.alert(gettext('Discovery'), msg);
                                reloadSessions();
                            },
                            failure: function (response) {
                                Ext.Msg.alert(gettext('Error'), response.htmlStatus);
                            },
                        });
                    },
                },
            ],
        });

        var sessionsGrid = Ext.create('Ext.grid.Panel', {
            title: gettext('Sessions'),
            flex: 2,
            store: sessionsStore,
            columns: [
                { text: gettext('Target IQN'), dataIndex: 'target_iqn', flex: 2 },
                { text: gettext('Portal'),     dataIndex: 'portal',     flex: 1 },
                { text: gettext('State'),      dataIndex: 'state',      width: 100 },
            ],
            tbar: [
                {
                    text: gettext('Reload'),
                    iconCls: 'fa fa-refresh',
                    handler: reloadSessions,
                },
                {
                    text: gettext('Login'),
                    iconCls: 'fa fa-plug',
                    handler: function () {
                        var sel = sessionsGrid.getSelection();
                        if (!sel.length) return;
                        var portals = portalsStore.collect('portal');
                        if (!portals.length) {
                            Ext.Msg.alert(gettext('Error'), gettext('Add portals first.'));
                            return;
                        }
                        portals.forEach(function (portal) {
                            Proxmox.Utils.API2Request({
                                url: '/nodes/' + nodename + '/iscsi/login',
                                method: 'POST',
                                params: {
                                    target_iqn: sel[0].data.target_iqn,
                                    portal: portal,
                                },
                                success: reloadSessions,
                                failure: function (r) {
                                    Ext.Msg.alert(gettext('Error'), r.htmlStatus);
                                },
                            });
                        });
                    },
                },
                {
                    text: gettext('Logout'),
                    iconCls: 'fa fa-sign-out',
                    handler: function () {
                        var sel = sessionsGrid.getSelection();
                        if (!sel.length) return;
                        Proxmox.Utils.API2Request({
                            url: '/nodes/' + nodename + '/iscsi/logout',
                            method: 'POST',
                            params: {
                                target_iqn: sel[0].data.target_iqn,
                                portal:     sel[0].data.portal,
                            },
                            success: reloadSessions,
                            failure: function (r) {
                                Ext.Msg.alert(gettext('Error'), r.htmlStatus);
                            },
                        });
                    },
                },
                {
                    text: gettext('Set Auto-Login'),
                    iconCls: 'fa fa-clock-o',
                    handler: function () {
                        var sel = sessionsGrid.getSelection();
                        if (!sel.length) return;
                        Ext.Msg.show({
                            title: gettext('Set Auto-Login Mode'),
                            msg: gettext('Choose startup mode for') + ' ' + sel[0].data.target_iqn,
                            buttons: Ext.Msg.OKCANCEL,
                            prompt: true,
                            value: 'automatic',
                            fn: function (btn, value) {
                                if (btn !== 'ok') return;
                                Proxmox.Utils.API2Request({
                                    url: '/nodes/' + nodename + '/iscsi/startup',
                                    method: 'PUT',
                                    params: {
                                        target_iqn: sel[0].data.target_iqn,
                                        portal:     sel[0].data.portal,
                                        mode:       value,
                                    },
                                    failure: function (r) {
                                        Ext.Msg.alert(gettext('Error'), r.htmlStatus);
                                    },
                                });
                            },
                        });
                    },
                },
            ],
        });

        Ext.apply(me, {
            items: [portalsGrid, sessionsGrid],
        });

        me.callParent();
        reloadSessions();
    },
});

Ext.define('PVE.node.MultipathPanel', {
    extend: 'Ext.panel.Panel',
    xtype: 'pveNodeMultipathPanel',

    layout: 'fit',

    initComponent: function () {
        var me = this;
        var nodename = me.pveSelNode.data.node;
        if (!nodename) throw 'no node name specified';

        var statusStore = Ext.create('Ext.data.Store', {
            fields: ['alias', 'wwid', 'paths', 'state'],
            proxy: {
                type: 'proxmox',
                url: '/api2/json/nodes/' + nodename + '/iscsi/multipath/status',
            },
        });

        var reload = function () { statusStore.load(); };

        var editConfig = function () {
            Proxmox.Utils.API2Request({
                url: '/api2/json/nodes/' + nodename + '/iscsi/multipath/config',
                method: 'GET',
                success: function (response) {
                    var content = response.result.data.content;
                    Ext.create('Proxmox.window.Edit', {
                        title: gettext('Edit /etc/multipath.conf'),
                        width: 700,
                        height: 500,
                        url: '/nodes/' + nodename + '/iscsi/multipath/config',
                        method: 'PUT',
                        items: [{
                            xtype: 'textarea',
                            name: 'content',
                            value: content,
                            height: 400,
                            fieldStyle: 'font-family: monospace; font-size: 12px;',
                        }],
                        listeners: { destroy: reload },
                    }).show();
                },
                failure: function (r) {
                    Ext.Msg.alert(gettext('Error'), r.htmlStatus);
                },
            });
        };

        Ext.apply(me, {
            items: [{
                xtype: 'grid',
                store: statusStore,
                columns: [
                    { text: gettext('Alias'),  dataIndex: 'alias',  flex: 1 },
                    { text: 'WWID',            dataIndex: 'wwid',   flex: 2 },
                    { text: gettext('Paths'),  dataIndex: 'paths',  width: 70, align: 'right' },
                    { text: gettext('State'),  dataIndex: 'state',  width: 100 },
                ],
                tbar: [
                    {
                        text: gettext('Reload'),
                        iconCls: 'fa fa-refresh',
                        handler: reload,
                    },
                    {
                        text: gettext('Edit Config'),
                        iconCls: 'fa fa-pencil',
                        handler: editConfig,
                    },
                    {
                        text: gettext('Restart multipathd'),
                        iconCls: 'fa fa-refresh',
                        handler: function () {
                            Proxmox.Utils.API2Request({
                                url: '/nodes/' + nodename + '/iscsi/multipath/config',
                                method: 'PUT',
                                params: { content: '', merge: 1 },
                                waitMsgTarget: me,
                                success: reload,
                                failure: function (r) {
                                    Ext.Msg.alert(gettext('Error'), r.htmlStatus);
                                },
                            });
                        },
                    },
                ],
            }],
        });

        me.callParent();
        reload();
    },
});

Ext.define('PVE.dc.ISCSISetupWizard', {
    extend: 'Proxmox.window.Wizard',
    xtype: 'pveDCISCSISetupWizard',

    title: gettext('SAN Setup Wizard'),
    width: 720,
    height: 550,

    // Track logins performed by this wizard session for rollback on Back
    _wizardLogins: [],

    initComponent: function () {
        var me = this;

        // Step 1: Select nodes + status
        var nodeStatusStore = Ext.create('Ext.data.Store', {
            fields: ['node', 'status', 'detail', 'checked',
                     { name: '_statusData', type: 'auto' }],
            data: [],
        });

        var nodeGrid = Ext.create('Ext.grid.Panel', {
            store: nodeStatusStore,
            columns: [
                {
                    xtype: 'checkcolumn',
                    header: '',
                    dataIndex: 'checked',
                    width: 40,
                },
                { text: gettext('Node'),   dataIndex: 'node',   flex: 1 },
                {
                    text: gettext('Status'),
                    dataIndex: 'status',
                    width: 80,
                    renderer: function (v) {
                        var colors = { green: '#2c9142', yellow: '#e59400',
                                       orange: '#d06020', red: '#cc2a2a' };
                        return '<span style="color:' + (colors[v] || '#333') + '">' +
                               Ext.String.htmlEncode(v) + '</span>';
                    },
                },
                { text: gettext('Detail'), dataIndex: 'detail', flex: 2 },
            ],
        });

        var checkNodeStatus = function () {
            nodeStatusStore.each(function (rec) {
                if (!rec.get('checked')) return;
                var node = rec.get('node');
                Proxmox.Utils.API2Request({
                    url: '/api2/json/nodes/' + node + '/iscsi/status',
                    method: 'GET',
                    success: function (response) {
                        var d = response.result.data;
                        var pkgsOk = d.packages.open_iscsi && d.packages.multipath_tools;
                        var svcsOk = d.services.iscsid.running && d.services.multipathd.running;
                        var hasSessions = d.sessions.length > 0;
                        var hasConfig = d.multipath_config_exists;

                        var status, detail;
                        if (!pkgsOk) {
                            status = 'orange';
                            detail = gettext('Packages missing');
                        } else if (svcsOk && hasSessions && hasConfig) {
                            status = 'green';
                            detail = gettext('Fully configured');
                        } else if (hasSessions || hasConfig) {
                            status = 'yellow';
                            detail = gettext('Partial') + ' (' + d.sessions.length +
                                     ' sessions, config=' + (hasConfig ? 'yes' : 'no') + ')';
                        } else {
                            status = 'red';
                            detail = gettext('Not configured');
                        }
                        rec.set('status', status);
                        rec.set('detail', detail);
                        rec.set('_statusData', d);
                        rec.commit();
                    },
                });
            });
        };

        // Load cluster nodes
        Proxmox.Utils.API2Request({
            url: '/api2/json/cluster/status',
            method: 'GET',
            success: function (response) {
                var nodes = (response.result.data || []).filter(n => n.type === 'node');
                nodeStatusStore.loadData(nodes.map(n => ({
                    node: n.name,
                    status: '...',
                    detail: '',
                    checked: true,
                })));
                checkNodeStatus();
            },
        });

        // Step 2: Portals
        var portalsStore = Ext.create('Ext.data.Store', {
            fields: ['portal'],
            data: [],
        });

        // Step 3: Targets
        var targetsStore = Ext.create('Ext.data.Store', {
            fields: ['target_iqn', 'portal', 'selected', 'already_connected'],
            data: [],
        });

        // Step 4 data (populated after login transition)
        var wwidsStore = Ext.create('Ext.data.Store', {
            fields: ['wwid', 'alias', 'is_new'],
            data: [],
        });

        Ext.apply(me, {
            items: [
                // --- Step 1 ---
                {
                    title: gettext('Select Nodes'),
                    xtype: 'panel',
                    itemId: 'step1',
                    layout: 'fit',
                    items: [nodeGrid],
                    tbar: [{
                        text: gettext('Refresh Status'),
                        iconCls: 'fa fa-refresh',
                        handler: checkNodeStatus,
                    }],
                },

                // --- Step 2 ---
                {
                    title: gettext('Portals'),
                    xtype: 'panel',
                    itemId: 'step2',
                    layout: 'fit',
                    items: [{
                        xtype: 'grid',
                        itemId: 'portalsGrid',
                        store: portalsStore,
                        columns: [{ text: gettext('Portal IP:port'), dataIndex: 'portal', flex: 1 }],
                        tbar: [
                            {
                                text: gettext('Add'),
                                iconCls: 'fa fa-plus',
                                handler: function () {
                                    Ext.Msg.prompt(gettext('Add Portal'), gettext('Portal IP:'),
                                        function (btn, val) {
                                            if (btn !== 'ok' || !val) return;
                                            var p = val.trim();
                                            if (!p.match(/:/)) p += ':3260';
                                            portalsStore.add({ portal: p });
                                        });
                                },
                            },
                            {
                                text: gettext('Remove'),
                                iconCls: 'fa fa-trash-o',
                                handler: function () {
                                    var g = me.down('#portalsGrid');
                                    var sel = g.getSelection();
                                    if (sel.length) portalsStore.remove(sel);
                                },
                            },
                        ],
                    }],
                },

                // --- Step 3 ---
                {
                    title: gettext('Select Targets'),
                    xtype: 'panel',
                    itemId: 'step3',
                    layout: 'fit',
                    items: [{
                        xtype: 'grid',
                        store: targetsStore,
                        columns: [
                            { xtype: 'checkcolumn', dataIndex: 'selected', header: '', width: 40 },
                            { text: gettext('Target IQN'), dataIndex: 'target_iqn', flex: 2 },
                            { text: gettext('Portal'),     dataIndex: 'portal',     flex: 1 },
                            { text: gettext('Status'),     dataIndex: 'already_connected',
                              renderer: function (v) { return v ? gettext('already connected') : ''; } },
                        ],
                    }],
                    tbar: [{
                        text: gettext('Discover'),
                        iconCls: 'fa fa-search',
                        handler: function () {
                            var firstNode = null;
                            nodeStatusStore.each(function (r) {
                                if (r.get('checked') && !firstNode) firstNode = r.get('node');
                            });
                            if (!firstNode) {
                                Ext.Msg.alert(gettext('Error'), gettext('Select at least one node.'));
                                return;
                            }
                            var portals = portalsStore.collect('portal').join(',');
                            Proxmox.Utils.API2Request({
                                url: '/api2/json/nodes/' + firstNode + '/iscsi/discover',
                                method: 'POST',
                                params: { portals: portals },
                                waitMsgTarget: me,
                                success: function (response) {
                                    var targets = response.result.data;
                                    var statusRec = nodeStatusStore.findRecord('node', firstNode);
                                    var sessions = (statusRec && statusRec.get('_statusData'))
                                        ? statusRec.get('_statusData').sessions : [];
                                    var connectedIqns = sessions.map(s => s.target_iqn);

                                    // Deduplicate by IQN
                                    var seen = {};
                                    var unique = targets.filter(function (t) {
                                        if (seen[t.target_iqn]) return false;
                                        seen[t.target_iqn] = true;
                                        return true;
                                    });
                                    targetsStore.loadData(unique.map(t => ({
                                        target_iqn: t.target_iqn,
                                        portal: t.portal,
                                        selected: true,
                                        already_connected: connectedIqns.includes(t.target_iqn),
                                    })));
                                },
                                failure: function (r) {
                                    Ext.Msg.alert(gettext('Error'), r.htmlStatus);
                                },
                            });
                        },
                    }],
                },

                // --- Step 4 ---
                {
                    title: gettext('Multipath Config'),
                    xtype: 'panel',
                    itemId: 'step4',
                    layout: {
                        type: 'vbox',
                        align: 'stretch',
                    },
                    items: [
                        {
                            xtype: 'container',
                            itemId: 'mergeToggleContainer',
                            html: '',
                            margin: '5 5 0 5',
                        },
                        {
                            xtype: 'grid',
                            itemId: 'wwidsGrid',
                            flex: 1,
                            columns: [
                                { text: 'WWID', dataIndex: 'wwid',  flex: 2 },
                                {
                                    text: gettext('Alias'),
                                    dataIndex: 'alias',
                                    flex: 1,
                                    editor: { xtype: 'textfield', allowBlank: false },
                                },
                                {
                                    text: gettext('New?'),
                                    dataIndex: 'is_new',
                                    renderer: function (v) { return v ? gettext('Yes') : ''; },
                                    width: 60,
                                },
                            ],
                            selModel: 'cellmodel',
                            plugins: [{ ptype: 'cellediting', clicksToEdit: 1 }],
                            store: wwidsStore,
                        },
                    ],
                },

                // --- Step 5: Services ---
                {
                    title: gettext('Services'),
                    xtype: 'panel',
                    itemId: 'step5',
                    bodyPadding: 10,
                    items: [
                        {
                            xtype: 'proxmoxcheckbox',
                            name: 'enable_iscsid',
                            boxLabel: gettext('Enable iscsid'),
                            itemId: 'chkIscsid',
                            value: true,
                        },
                        {
                            xtype: 'proxmoxcheckbox',
                            name: 'enable_multipathd',
                            boxLabel: gettext('Enable multipathd'),
                            itemId: 'chkMultipathd',
                            value: true,
                        },
                        {
                            xtype: 'proxmoxcheckbox',
                            name: 'enable_lvmlockd',
                            boxLabel: gettext('Enable lvmlockd (recommended for clusters)'),
                            itemId: 'chkLvmlockd',
                            value: false,
                        },
                        {
                            xtype: 'proxmoxcheckbox',
                            name: 'enable_sanlock',
                            boxLabel: gettext('Enable sanlock (required with lvmlockd)'),
                            itemId: 'chkSanlock',
                            value: false,
                        },
                    ],
                },

                // --- Step 6: Apply ---
                {
                    title: gettext('Apply'),
                    xtype: 'panel',
                    itemId: 'step6',
                    layout: 'fit',
                    items: [{
                        xtype: 'container',
                        itemId: 'progressContainer',
                        layout: { type: 'vbox', align: 'stretch' },
                        scrollable: true,
                        items: [],
                    }],
                },
            ],
        });

        // Step 3 -> 4 transition: login newly selected targets, then fetch WWIDs
        me.on('beforenextcard', function (wizard, current) {
            if (current.itemId === 'step3') {
                var nodes = [];
                nodeStatusStore.each(function (r) {
                    if (r.get('checked')) nodes.push(r.get('node'));
                });
                if (!nodes.length) {
                    Ext.Msg.alert(gettext('Error'), gettext('Select at least one node.'));
                    return false;
                }

                var selectedTargets = [];
                targetsStore.each(function (r) {
                    if (r.get('selected') && !r.get('already_connected')) {
                        selectedTargets.push(r.get('target_iqn'));
                    }
                });
                var portals = portalsStore.collect('portal');
                var firstNode = nodes[0];
                var loginPromises = [];

                selectedTargets.forEach(function (iqn) {
                    portals.forEach(function (portal) {
                        var p = new Promise(function (resolve) {
                            Proxmox.Utils.API2Request({
                                url: '/nodes/' + firstNode + '/iscsi/login',
                                method: 'POST',
                                params: { target_iqn: iqn, portal: portal },
                                success: function (r) {
                                    if (!r.result.data.already_connected) {
                                        me._wizardLogins.push({ node: firstNode, iqn: iqn, portal: portal });
                                    }
                                    resolve();
                                },
                                failure: resolve,
                            });
                        });
                        loginPromises.push(p);
                    });
                });

                Promise.all(loginPromises).then(function () {
                    Proxmox.Utils.API2Request({
                        url: '/api2/json/nodes/' + firstNode + '/iscsi/status',
                        method: 'GET',
                        success: function (response) {
                            var d = response.result.data;
                            var existingWwids = (d.multipath_devices || []).map(m => m.wwid);
                            var wwidsGrid = me.down('#wwidsGrid');
                            var store = wwidsGrid.getStore();
                            store.removeAll();

                            (d.multipath_devices || []).forEach(function (dev) {
                                store.add({ wwid: dev.wwid, alias: dev.alias, is_new: false });
                            });

                            Proxmox.Utils.API2Request({
                                url: '/api2/json/nodes/' + firstNode + '/iscsi/multipath/status',
                                method: 'GET',
                                success: function (r2) {
                                    (r2.result.data || []).forEach(function (dev) {
                                        if (!existingWwids.includes(dev.wwid)) {
                                            store.add({ wwid: dev.wwid, alias: dev.alias || '', is_new: true });
                                        }
                                    });
                                    wizard.navigateToNextCard();
                                },
                            });
                        },
                    });
                });

                return false; // prevent automatic navigation
            }

            // Step 4 -> 5: pre-populate service checkboxes from cluster size
            if (current.itemId === 'step4') {
                Proxmox.Utils.API2Request({
                    url: '/api2/json/cluster/status',
                    method: 'GET',
                    success: function (r) {
                        var nodeCount = (r.result.data || []).filter(n => n.type === 'node').length;
                        var isCluster = nodeCount > 1;
                        me.down('#chkLvmlockd').setValue(isCluster);
                        me.down('#chkSanlock').setValue(isCluster);
                    },
                });
            }
        });

        // Back from Step 4: roll back logins this wizard performed
        me.on('beforeprevcard', function (wizard, current) {
            if (current.itemId === 'step4') {
                me._wizardLogins.forEach(function (login) {
                    Proxmox.Utils.API2Request({
                        url: '/nodes/' + login.node + '/iscsi/logout',
                        method: 'POST',
                        params: { target_iqn: login.iqn, portal: login.portal },
                    });
                });
                me._wizardLogins = [];
            }
        });

        // Apply step: run setup on each node sequentially
        me.on('beforefinish', function () {
            var nodes = [];
            nodeStatusStore.each(function (r) { if (r.get('checked')) nodes.push(r.get('node')); });

            var targets = [];
            targetsStore.each(function (r) { if (r.get('selected')) targets.push(r.get('target_iqn')); });

            var portals = portalsStore.collect('portal').join(',');

            var wwidsGrid = me.down('#wwidsGrid');
            var mpConfig = 'defaults {\n    user_friendly_names yes\n    find_multipaths yes\n}\n\n';
            mpConfig += 'blacklist {\n    devnode "^sda"\n}\n\n';
            mpConfig += 'multipaths {\n';
            wwidsGrid.getStore().each(function (r) {
                if (r.get('is_new')) {
                    mpConfig += '    multipath {\n';
                    mpConfig += '        wwid ' + r.get('wwid') + '\n';
                    mpConfig += '        alias ' + r.get('alias') + '\n';
                    mpConfig += '    }\n';
                }
            });
            mpConfig += '}\n';

            var enableLvmlockd = me.down('#chkLvmlockd').getValue();
            var enableSanlock  = me.down('#chkSanlock').getValue();

            var container = me.down('#progressContainer');
            container.removeAll();

            var runNextNode = function (idx) {
                if (idx >= nodes.length) {
                    container.add({
                        xtype: 'displayfield',
                        value: '<b>' + gettext('All nodes complete.') + '</b>',
                        margin: '10 0 0 0',
                    });
                    return;
                }
                var node = nodes[idx];
                var section = Ext.create('Ext.panel.Panel', {
                    title: node,
                    collapsible: true,
                    bodyPadding: 5,
                    items: [{
                        xtype: 'textarea',
                        readOnly: true,
                        height: 150,
                        fieldStyle: 'font-family: monospace; font-size: 11px;',
                        itemId: 'log-' + node,
                    }],
                });
                container.add(section);

                Proxmox.Utils.API2Request({
                    url: '/nodes/' + node + '/iscsi/setup',
                    method: 'POST',
                    params: {
                        portals:          portals,
                        targets:          targets.join(','),
                        multipath_config: mpConfig,
                        merge_multipath:  0,
                        enable_lvmlockd:  enableLvmlockd ? 1 : 0,
                        enable_sanlock:   enableSanlock  ? 1 : 0,
                    },
                    success: function (response) {
                        var upid = response.result.data;
                        var logArea = section.down('#log-' + node);
                        var poll = setInterval(function () {
                            Proxmox.Utils.API2Request({
                                url: '/api2/json/nodes/' + node + '/tasks/' + encodeURIComponent(upid) + '/log',
                                method: 'GET',
                                params: { start: 0, limit: 500 },
                                success: function (r) {
                                    var lines = (r.result.data || []).map(l => l.t).join('\n');
                                    logArea.setValue(lines);
                                },
                            });
                            Proxmox.Utils.API2Request({
                                url: '/api2/json/nodes/' + node + '/tasks/' + encodeURIComponent(upid) + '/status',
                                method: 'GET',
                                success: function (r) {
                                    if (r.result.data.status === 'stopped') {
                                        clearInterval(poll);
                                        runNextNode(idx + 1);
                                    }
                                },
                            });
                        }, 2000);
                    },
                    failure: function (r) {
                        section.down('#log-' + node).setValue('ERROR: ' + r.htmlStatus);
                        runNextNode(idx + 1);
                    },
                });
            };

            runNextNode(0);
            return false; // Keep wizard open so user sees progress
        });

        me.callParent();
    },
});

// Inject "SAN Setup" button into the Datacenter > Storage panel toolbar
// xtype confirmed: PVE.dc.StorageView (alias: pveStorageView)
Ext.define(null, {
    override: 'PVE.dc.StorageView',

    initComponent: function () {
        this.callParent(arguments);
        var toolbar = this.down('toolbar[dock=top]');
        if (toolbar) {
            toolbar.add({
                text: gettext('SAN Setup'),
                iconCls: 'fa fa-plug',
                handler: function () {
                    Ext.create('PVE.dc.ISCSISetupWizard', { autoShow: true });
                },
            });
        }
    },
});

// Inject iSCSI and Multipath tabs into the node Config panel (storage group)
Ext.define(null, {
    override: 'PVE.node.Config',

    initComponent: function () {
        this.callParent(arguments);

        var me = this;
        var caps = Ext.state.Manager.get('GuiCap');

        if (caps.nodes['Sys.Audit']) {
            me.add([
                {
                    xtype: 'pveNodeISCSIPanel',
                    title: 'iSCSI',
                    itemId: 'iscsi',
                    iconCls: 'fa fa-plug',
                    groups: ['storage'],
                    pveSelNode: me.pveSelNode,
                },
                {
                    xtype: 'pveNodeMultipathPanel',
                    title: 'Multipath',
                    itemId: 'multipath',
                    iconCls: 'fa fa-sitemap',
                    groups: ['storage'],
                    pveSelNode: me.pveSelNode,
                },
            ]);
        }
    },
});
