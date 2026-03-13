// pve-iscsi-multipath: Proxmox VE iSCSI/Multipath Plugin
// Datacenter storage panel xtype: PVE.dc.StorageView (alias: pveStorageView)
// Nodeinfo class: PVE::API2::Nodes::Nodeinfo starts at line 1 of Nodes.pm

Ext.define('PVE.node.ConfigureMultipathDialog', {
    extend: 'Ext.window.Window',
    xtype: 'pveConfigureMultipathDialog',

    title: gettext('Configure Multipath'),
    width: 450,
    modal: true,
    resizable: false,
    bodyPadding: 10,

    // Set by caller: nodename required; plus target_iqn+portal OR fc_wwpn
    nodename: null,
    target_iqn: null,
    portal: null,
    fc_wwpn: null,

    initComponent: function () {
        const me = this;

        let wwid = '';

        const wwid_display = Ext.create('Ext.form.field.Display', {
            fieldLabel: 'WWID',
            value: '',
        });

        const alias_field = Ext.create('Ext.form.field.Text', {
            fieldLabel: gettext('Alias'),
            allowBlank: false,
            validateOnBlur: false,
            regex: /^\S+$/,
            regexText: gettext('Alias must not contain spaces'),
        });

        Ext.apply(me, {
            items: [wwid_display, alias_field],
            buttons: [
                {
                    text: gettext('Configure'),
                    itemId: 'configureBtn',
                    disabled: true,
                    handler: function () {
                        const alias = alias_field.getValue().trim();
                        if (!alias) {
                            alias_field.markInvalid(gettext('Alias is required'));
                            return;
                        }
                        Proxmox.Utils.API2Request({
                            url: '/nodes/' + me.nodename + '/iscsi/multipath/add-device',
                            method: 'POST',
                            params: { wwid: wwid, alias: alias },
                            waitMsgTarget: me,
                            success: function () {
                                me.fireEvent('configured');
                                me.close();
                            },
                            failure: function (r) {
                                Ext.Msg.alert(gettext('Error'), r.htmlStatus);
                            },
                        });
                    },
                },
                {
                    text: gettext('Cancel'),
                    handler: function () { me.close(); },
                },
            ],
        });

        me.callParent();

        // Discover WWID immediately on open
        me.setLoading(gettext('Detecting WWID\u2026'));

        const params = me.fc_wwpn
            ? { fc_wwpn: me.fc_wwpn }
            : { target_iqn: me.target_iqn, portal: me.portal };

        Proxmox.Utils.API2Request({
            url: '/nodes/' + me.nodename + '/iscsi/multipath/wwid',
            method: 'GET',
            params: params,
            success: function (response) {
                me.setLoading(false);
                const d = response.result.data;

                if (!d.wwid) {
                    me.close();
                    Ext.Msg.show({
                        title: gettext('No Device Found'),
                        icon: Ext.Msg.INFO,
                        message: gettext('No multipath device detected for this target. ' +
                                         'Ensure multipathd is running and the device is visible.'),
                        buttons: Ext.Msg.OK,
                    });
                    return;
                }
                if (d.already_configured) {
                    me.close();
                    Ext.Msg.show({
                        title: gettext('Already Configured'),
                        icon: Ext.Msg.INFO,
                        message: Ext.String.format(
                            gettext("WWID {0} is already configured as '{1}'."),
                            d.wwid,
                            d.existing_alias || '(unknown)'),
                        buttons: Ext.Msg.OK,
                    });
                    return;
                }

                wwid = d.wwid;
                wwid_display.setValue(d.wwid);
                me.down('#configureBtn').enable();
                alias_field.focus();
            },
            failure: function (r) {
                me.setLoading(false);
                me.close();
                Ext.Msg.alert(gettext('Error'), r.htmlStatus);
            },
        });
    },
});

Ext.define('PVE.node.ISCSIAddLvmDialog', {
    extend: 'Proxmox.window.Edit',

    // Both must be set by caller before .show().
    // NOTE: 'alias' is reserved by Ext.define for widget alias registration;
    // the multipath alias is stored under 'deviceAlias' instead.
    nodename:    null,
    deviceAlias: null,

    subject: gettext('LVM Storage'),
    isCreate: true,
    method: 'POST',

    initComponent: function() {
        const me = this;

        // url MUST be set before callParent — Proxmox.window.Edit reads it at open time.
        // Ext.applyIf so the caller can override (consistent with PVE.node.CreateLVM pattern).
        Ext.applyIf(me, {
            url: '/nodes/' + me.nodename + '/iscsi/lvm-setup',
        });

        // Items are wrapped in Proxmox.panel.InputPanel rather than passed as a flat
        // items array (as in PVE.node.CreateLVM) because we need onGetValues to perform
        // pre-submit transforms. This deviation from CreateLVM is intentional.
        Ext.apply(me, {
            items: [{
                xtype: 'inputpanel',
                onGetValues: function(values) {
                    const win = this.up('window');

                    // pveNodeSelector with multiSelect:true returns an array.
                    // The Perl API declares 'nodes' as a comma-separated string (type=>'string').
                    // Join the array; use delete (not undefined) so absent key = all nodes.
                    if (Ext.isArray(values.nodes) && values.nodes.length) {
                        values.nodes = values.nodes.join(',');
                    } else {
                        delete values.nodes;
                    }

                    // Stash final values for the destroy callback.
                    // onGetValues runs only on submit, never on cancel.
                    // win.submittedShared is undefined on cancel, false/0 when Shared is unchecked.
                    // The destroy guard (!win.submittedShared) intentionally covers both cases:
                    // neither cancel nor shared=0 should trigger lvm-scan on remote nodes.
                    win.submittedShared = !!values.shared;
                    win.submittedNodes  = values.nodes || '';

                    // 'device' is not in the form (displayfield.submitValue=false by default).
                    // Inject it from the dialog config so the Perl API receives it.
                    values.device = win.deviceAlias;

                    return values;
                },
                items: [
                    {
                        xtype: 'displayfield',
                        fieldLabel: gettext('Device'),
                        // submitValue defaults to false on displayfield — not sent in POST
                        value: '/dev/mapper/' + me.deviceAlias,
                    },
                    {
                        xtype: 'textfield',
                        name: 'vg_name',
                        fieldLabel: gettext('VG Name'),
                        value: me.deviceAlias + '-vg',
                        allowBlank: false,
                        regex: /^\S+$/,
                        regexText: gettext('No spaces allowed'),
                    },
                    {
                        xtype: 'textfield',
                        name: 'storage_id',
                        fieldLabel: gettext('Storage ID'),
                        value: me.deviceAlias,
                        allowBlank: false,
                        regex: /^\S+$/,
                        regexText: gettext('No spaces allowed'),
                    },
                    {
                        xtype: 'proxmoxcheckbox',
                        name: 'enable',
                        fieldLabel: gettext('Enable'),
                        checked: true,
                        uncheckedValue: 0,
                    },
                    {
                        xtype: 'proxmoxcheckbox',
                        name: 'shared',
                        fieldLabel: gettext('Shared'),
                        checked: true,
                        uncheckedValue: 0,
                        listeners: {
                            change: function(cb, val) {
                                const nodesField = cb.up('inputpanel').down('[name=nodes]');
                                if (!val) {
                                    nodesField.setValue('');
                                    nodesField.disable();
                                } else {
                                    nodesField.enable();
                                }
                            },
                        },
                    },
                    {
                        xtype: 'pveNodeSelector',
                        name: 'nodes',
                        fieldLabel: gettext('Nodes'),
                        multiSelect: true,
                        autoSelect: false,
                        emptyText: gettext('All') + ' (' + gettext('No restrictions') + ')',
                    },
                    {
                        xtype: 'proxmoxcheckbox',
                        name: 'snapshot_as_volume_chain',
                        fieldLabel: gettext('Allow Snapshots as Volume-Chain'),
                        checked: true,
                        uncheckedValue: 0,
                    },
                ],
            }],
        });

        me.callParent();
    },

    apiCallDone: function(success, response, options) {
        if (!success) return;
        const d = (response.result && response.result.data) || {};
        const warns = [];
        if (d.pv_existed)      warns.push(gettext('PV already existed \u2014 skipped pvcreate'));
        if (d.vg_existed)      warns.push(gettext('VG already existed \u2014 skipped vgcreate'));
        if (d.storage_existed) warns.push(gettext('Storage already registered \u2014 skipped'));
        if (warns.length) {
            Ext.Msg.show({
                title:   gettext('Add LVM Storage'),
                icon:    Ext.Msg.INFO,
                message: warns.join('<br>'),
                buttons: Ext.Msg.OK,
            });
        }
    },
});

Ext.define('PVE.node.ISCSIPanel', {
    extend: 'Ext.panel.Panel',
    xtype: 'pveNodeISCSIPanel',
    onlineHelp: 'chapter_storage',

    layout: {
        type: 'hbox',
        align: 'stretch',
    },

    initComponent: function () {
        const me = this;
        const nodename = me.pveSelNode.data.node;
        if (!nodename) throw 'no node name specified';

        const portalsStore = Ext.create('Ext.data.Store', {
            fields: ['portal'],
            data: [],
        });

        const sessionsStore = Ext.create('Ext.data.Store', {
            fields: ['target_iqn', 'portal', 'state'],
            proxy: {
                type: 'proxmox',
                url: '/api2/json/nodes/' + nodename + '/iscsi/sessions',
            },
        });

        sessionsStore.on('load', function (store, records) {
            records.forEach(function (record) {
                const portal = record.get('portal');
                if (!portalsStore.findRecord('portal', portal, 0, false, false, true)) {
                    portalsStore.add({ portal: portal });
                }
            });
        });

        const reloadSessions = function () {
            sessionsStore.load();
        };

        const portalsGrid = Ext.create('Ext.grid.Panel', {
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
                                let portal = value.trim();
                                if (!portal.match(/:/)) portal += ':3260';
                                portalsStore.add({ portal: portal });
                            });
                    },
                },
                {
                    text: gettext('Remove'),
                    iconCls: 'fa fa-trash-o',
                    handler: function () {
                        const sel = portalsGrid.getSelection();
                        if (sel.length) portalsStore.remove(sel);
                    },
                },
                {
                    text: gettext('Discover Targets'),
                    iconCls: 'fa fa-search',
                    handler: function () {
                        const portals = portalsStore.collect('portal').join(',');
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
                                const targets = response.result.data;
                                if (!targets.length) {
                                    Ext.Msg.show({
                                        title: gettext('Discovery'),
                                        icon: Ext.Msg.INFO,
                                        message: gettext('No targets found.'),
                                        buttons: Ext.Msg.OK,
                                    });
                                    return;
                                }
                                // Deduplicate by IQN — one row per target
                                const seen = {};
                                const unique = targets.filter(function (t) {
                                    if (seen[t.target_iqn]) return false;
                                    seen[t.target_iqn] = true;
                                    return true;
                                });
                                const discStore = Ext.create('Ext.data.Store', {
                                    fields: ['target_iqn', 'portal'],
                                    data: unique,
                                });
                                const discGrid = Ext.create('Ext.grid.Panel', {
                                    store: discStore,
                                    selModel: { selType: 'checkboxmodel', mode: 'MULTI' },
                                    columns: [
                                        { text: gettext('Target IQN'), dataIndex: 'target_iqn', flex: 2 },
                                        { text: gettext('Portal'),     dataIndex: 'portal',     flex: 1 },
                                    ],
                                    height: 200,
                                    border: false,
                                });
                                const discWin = Ext.create('Ext.window.Window', {
                                    title: gettext('Discovered Targets'),
                                    width: 580,
                                    modal: true,
                                    bodyPadding: 0,
                                    items: [discGrid],
                                    buttons: [
                                        {
                                            text: gettext('Login Selected'),
                                            iconCls: 'fa fa-plug',
                                            handler: function () {
                                                const sel = discGrid.getSelection();
                                                if (!sel.length) return;
                                                const portals = portalsStore.collect('portal');
                                                let done = 0;
                                                const total = sel.length * portals.length;
                                                sel.forEach(function (rec) {
                                                    portals.forEach(function (portal) {
                                                        Proxmox.Utils.API2Request({
                                                            url: '/nodes/' + nodename + '/iscsi/login',
                                                            method: 'POST',
                                                            params: { target_iqn: rec.get('target_iqn'), portal: portal },
                                                            success: function () {
                                                                if (++done === total) { discWin.close(); reloadSessions(); }
                                                            },
                                                            failure: function (r) {
                                                                Ext.Msg.alert(gettext('Error'), r.htmlStatus);
                                                            },
                                                        });
                                                    });
                                                });
                                            },
                                        },
                                        {
                                            text: gettext('Close'),
                                            handler: function () { discWin.close(); reloadSessions(); },
                                        },
                                    ],
                                });
                                discWin.show();
                            },
                            failure: function (response) {
                                Ext.Msg.alert(gettext('Error'), response.htmlStatus);
                            },
                        });
                    },
                },
            ],
        });

        const sessionsGrid = Ext.create('Ext.grid.Panel', {
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
                        const sel = sessionsGrid.getSelection();
                        if (!sel.length) return;
                        const portals = portalsStore.collect('portal');
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
                        const sel = sessionsGrid.getSelection();
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
                        const sel = sessionsGrid.getSelection();
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
                {
                    text: gettext('Configure Multipath'),
                    iconCls: 'fa fa-link',
                    itemId: 'iscsiConfigMpBtn',
                    disabled: true,
                    handler: function () {
                        const sel = sessionsGrid.getSelection();
                        if (!sel.length) return;
                        Ext.create('PVE.node.ConfigureMultipathDialog', {
                            nodename: nodename,
                            target_iqn: sel[0].get('target_iqn'),
                            portal: sel[0].get('portal'),
                        }).show();
                    },
                },
                {
                    text: gettext('Add LVM Storage'),
                    iconCls: 'fa fa-database',
                    itemId: 'iscsiAddLvmBtn',
                    disabled: true,
                    handler: function () {
                        const sel = sessionsGrid.getSelection();
                        if (!sel.length) return;
                        const target_iqn = sel[0].get('target_iqn');
                        const portal = sel[0].get('portal');

                        // Get WWID/alias for this session to pre-fill fields
                        Proxmox.Utils.API2Request({
                            url: '/nodes/' + nodename + '/iscsi/multipath/wwid',
                            method: 'GET',
                            params: { target_iqn: target_iqn, portal: portal },
                            success: function (response) {
                                const d = response.result.data;
                                if (!d.wwid) {
                                    Ext.Msg.show({
                                        title: gettext('Add LVM Storage'),
                                        icon: Ext.Msg.WARNING,
                                        message: gettext('No multipath device found for this target. Configure Multipath first.'),
                                        buttons: Ext.Msg.OK,
                                    });
                                    return;
                                }
                                const alias = d.existing_alias || d.wwid;
                                Ext.create('PVE.node.ISCSIAddLvmDialog', {
                                    nodename:    nodename,
                                    deviceAlias: alias,
                                    listeners: {
                                        destroy: function(win) {
                                            // win.submittedShared is only set by onGetValues, which only
                                            // runs on submit (never on cancel). !win.submittedShared
                                            // covers both user cancel (undefined) and submit with Shared
                                            // unchecked (false/0) — neither case should trigger lvm-scan.
                                            if (!win.submittedShared) return;

                                            const nodesVal = win.submittedNodes;
                                            if (nodesVal) {
                                                // Scan only selected nodes, skipping the current node
                                                nodesVal.split(',')
                                                    .filter(function(n) { return n !== nodename; })
                                                    .forEach(function(n) {
                                                        Proxmox.Utils.API2Request({
                                                            url: '/nodes/' + n + '/iscsi/lvm-scan',
                                                            method: 'POST',
                                                        });
                                                    });
                                            } else {
                                                // No nodes specified means all nodes — fetch cluster and scan all others
                                                Proxmox.Utils.API2Request({
                                                    url: '/cluster/status',
                                                    method: 'GET',
                                                    success: function(cr) {
                                                        (cr.result.data || [])
                                                            .filter(function(n) { return n.type === 'node' && n.name !== nodename; })
                                                            .forEach(function(n) {
                                                                Proxmox.Utils.API2Request({
                                                                    url: '/nodes/' + n.name + '/iscsi/lvm-scan',
                                                                    method: 'POST',
                                                                });
                                                            });
                                                    },
                                                });
                                            }
                                        },
                                    },
                                }).show();
                            },
                            failure: function (r) {
                                Ext.Msg.alert(gettext('Error'), r.htmlStatus);
                            },
                        });
                    },
                },
            ],
            listeners: {
                selectionchange: function (sm, selected) {
                    sessionsGrid.down('#iscsiConfigMpBtn').setDisabled(!selected.length);
                    sessionsGrid.down('#iscsiAddLvmBtn').setDisabled(!selected.length);
                },
            },
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
    onlineHelp: 'chapter_storage',

    layout: 'fit',

    initComponent: function () {
        const me = this;
        const nodename = me.pveSelNode.data.node;
        if (!nodename) throw 'no node name specified';

        const statusStore = Ext.create('Ext.data.Store', {
            fields: ['alias', 'wwid', 'paths', 'state'],
            proxy: {
                type: 'proxmox',
                url: '/api2/json/nodes/' + nodename + '/iscsi/multipath/status',
            },
        });

        const reload = function () { statusStore.load(); };

        const editConfig = function () {
            Proxmox.Utils.API2Request({
                url: '/nodes/' + nodename + '/iscsi/multipath/config',
                method: 'GET',
                success: function (response) {
                    const content = response.result.data.content;
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

Ext.define('PVE.node.FCPanel', {
    extend: 'Ext.panel.Panel',
    xtype: 'pveNodeFCPanel',
    onlineHelp: 'chapter_storage',

    layout: {
        type: 'hbox',
        align: 'stretch',
    },

    initComponent: function () {
        const me = this;
        const nodename = me.pveSelNode.data.node;
        if (!nodename) throw 'no node name specified';

        const hbasStore = Ext.create('Ext.data.Store', {
            fields: ['name', 'port_name', 'node_name', 'port_state', 'speed', 'symbolic_name'],
            proxy: {
                type: 'proxmox',
                url: '/api2/json/nodes/' + nodename + '/iscsi/fc/hbas',
            },
        });

        const targetsStore = Ext.create('Ext.data.Store', {
            fields: ['port_name', 'node_name', 'hba', 'port_state'],
            proxy: {
                type: 'proxmox',
                url: '/api2/json/nodes/' + nodename + '/iscsi/fc/targets',
            },
        });

        const reload = function () {
            hbasStore.load();
            targetsStore.load();
        };

        const rescan = function () {
            Proxmox.Utils.API2Request({
                url: '/nodes/' + nodename + '/iscsi/fc/rescan',
                method: 'POST',
                waitMsgTarget: me,
                success: function () {
                    Ext.defer(reload, 2000);
                },
                failure: function (r) {
                    Ext.Msg.alert(gettext('Error'), r.htmlStatus);
                },
            });
        };

        const stateRenderer = function (v) {
            const color = (v === 'Online') ? '#2c9142' : '#cc2a2a';
            return '<span style="color:' + color + '">' + Ext.String.htmlEncode(v || '') + '</span>';
        };

        const fcTargetsGrid = Ext.create('Ext.grid.Panel', {
            title: gettext('Connected FC Targets'),
            flex: 2,
            store: targetsStore,
            columns: [
                { text: 'Remote WWPN',      dataIndex: 'port_name',  flex: 2 },
                { text: gettext('Via HBA'), dataIndex: 'hba',        width: 70 },
                { text: gettext('State'),   dataIndex: 'port_state', width: 80, renderer: stateRenderer },
            ],
            tbar: [
                {
                    text: gettext('Configure Multipath'),
                    iconCls: 'fa fa-link',
                    itemId: 'fcConfigMpBtn',
                    disabled: true,
                    handler: function () {
                        const sel = fcTargetsGrid.getSelection();
                        if (!sel.length) return;
                        Ext.create('PVE.node.ConfigureMultipathDialog', {
                            nodename: nodename,
                            fc_wwpn: sel[0].get('port_name'),
                            listeners: { configured: reload },
                        }).show();
                    },
                },
            ],
            listeners: {
                selectionchange: function (sm, selected) {
                    fcTargetsGrid.down('#fcConfigMpBtn').setDisabled(!selected.length);
                },
            },
        });

        Ext.apply(me, {
            items: [
                {
                    xtype: 'grid',
                    title: gettext('Local HBAs'),
                    flex: 1,
                    store: hbasStore,
                    columns: [
                        { text: gettext('HBA'),   dataIndex: 'name',      width: 70 },
                        { text: 'WWPN',           dataIndex: 'port_name', flex: 2 },
                        { text: gettext('Speed'),  dataIndex: 'speed',     width: 80 },
                        { text: gettext('State'),  dataIndex: 'port_state', width: 80, renderer: stateRenderer },
                    ],
                    tbar: [
                        {
                            text: gettext('Reload'),
                            iconCls: 'fa fa-refresh',
                            handler: reload,
                        },
                        {
                            text: gettext('Rescan Fabric'),
                            iconCls: 'fa fa-search',
                            handler: rescan,
                        },
                    ],
                },
                fcTargetsGrid,
            ],
        });

        me.callParent();
        reload();
    },
});

// Inject iSCSI and Multipath tabs into the node Config panel (storage group).
// Must override PVE.panel.Config (not PVE.node.Config) so we can push into
// me.items before PVE.panel.Config.initComponent builds the navigation tree.
Ext.define(null, {
    override: 'PVE.panel.Config',

    initComponent: function () {
        const me = this;

        if (me.$className === 'PVE.node.Config') {
            const caps = Ext.state.Manager.get('GuiCap');
            if (caps && caps.nodes && caps.nodes['Sys.Audit']) {
                if (!Ext.isArray(me.items)) me.items = [];
                me.items.push(
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
                    {
                        xtype: 'pveNodeFCPanel',
                        title: 'Fibre Channel',
                        itemId: 'fc',
                        iconCls: 'fa fa-circle-o',
                        groups: ['storage'],
                        pveSelNode: me.pveSelNode,
                    }
                );
            }
        }

        this.callParent(arguments);
    },
});
