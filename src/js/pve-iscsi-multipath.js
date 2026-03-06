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
        var me = this;

        var wwid = '';

        var wwid_display = Ext.create('Ext.form.field.Display', {
            fieldLabel: 'WWID',
            value: '',
        });

        var alias_field = Ext.create('Ext.form.field.Text', {
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
                        var alias = alias_field.getValue().trim();
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

        var params = me.fc_wwpn
            ? { fc_wwpn: me.fc_wwpn }
            : { target_iqn: me.target_iqn, portal: me.portal };

        Proxmox.Utils.API2Request({
            url: '/nodes/' + me.nodename + '/iscsi/multipath/wwid',
            method: 'GET',
            params: params,
            success: function (response) {
                me.setLoading(false);
                var d = response.result.data;

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

        sessionsStore.on('load', function (store, records) {
            records.forEach(function (record) {
                var portal = record.get('portal');
                if (!portalsStore.findRecord('portal', portal, 0, false, false, true)) {
                    portalsStore.add({ portal: portal });
                }
            });
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
                                    Ext.Msg.show({
                                        title: gettext('Discovery'),
                                        icon: Ext.Msg.INFO,
                                        message: gettext('No targets found.'),
                                        buttons: Ext.Msg.OK,
                                    });
                                    return;
                                }
                                // Deduplicate by IQN — one row per target
                                var seen = {};
                                var unique = targets.filter(function (t) {
                                    if (seen[t.target_iqn]) return false;
                                    seen[t.target_iqn] = true;
                                    return true;
                                });
                                var discStore = Ext.create('Ext.data.Store', {
                                    fields: ['target_iqn', 'portal'],
                                    data: unique,
                                });
                                var discGrid = Ext.create('Ext.grid.Panel', {
                                    store: discStore,
                                    selModel: { selType: 'checkboxmodel', mode: 'MULTI' },
                                    columns: [
                                        { text: gettext('Target IQN'), dataIndex: 'target_iqn', flex: 2 },
                                        { text: gettext('Portal'),     dataIndex: 'portal',     flex: 1 },
                                    ],
                                    height: 200,
                                    border: false,
                                });
                                var discWin = Ext.create('Ext.window.Window', {
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
                                                var sel = discGrid.getSelection();
                                                if (!sel.length) return;
                                                var portals = portalsStore.collect('portal');
                                                var done = 0, total = sel.length * portals.length;
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

        var showAddLvmDialog = function (alias) {
            var dlg = Ext.create('Ext.window.Window', {
                title: gettext('Add LVM Storage'),
                width: 420,
                modal: true,
                resizable: false,
                bodyPadding: 10,
                items: [
                    {
                        xtype: 'displayfield',
                        fieldLabel: gettext('Device'),
                        value: '/dev/mapper/' + alias,
                        labelWidth: 100,
                    },
                    {
                        xtype: 'textfield',
                        fieldLabel: gettext('VG Name'),
                        itemId: 'dlgVgName',
                        labelWidth: 100,
                        value: alias + '-vg',
                        allowBlank: false,
                        regex: /^\S+$/,
                        regexText: gettext('No spaces allowed'),
                    },
                    {
                        xtype: 'textfield',
                        fieldLabel: gettext('Storage ID'),
                        itemId: 'dlgStorageId',
                        labelWidth: 100,
                        value: alias,
                        allowBlank: false,
                        regex: /^\S+$/,
                        regexText: gettext('No spaces allowed'),
                    },
                ],
                buttons: [
                    {
                        text: gettext('Add'),
                        handler: function () {
                            var vgName = dlg.down('#dlgVgName').getValue().trim();
                            var storageId = dlg.down('#dlgStorageId').getValue().trim();
                            if (!vgName || !storageId) return;

                            dlg.setLoading(gettext('Creating LVM storage\u2026'));
                            Proxmox.Utils.API2Request({
                                url: '/nodes/' + nodename + '/iscsi/lvm-setup',
                                method: 'POST',
                                params: { device: alias, vg_name: vgName, storage_id: storageId },
                                success: function (r) {
                                    dlg.setLoading(false);
                                    var d = r.result.data;
                                    var warns = [];
                                    if (d.pv_existed)      warns.push(gettext('PV already existed — skipped pvcreate'));
                                    if (d.vg_existed)      warns.push(gettext('VG already existed — skipped vgcreate'));
                                    if (d.storage_existed) warns.push(gettext('Storage already registered — skipped'));
                                    if (warns.length) {
                                        Ext.Msg.show({
                                            title: gettext('Add LVM Storage'),
                                            icon: Ext.Msg.INFO,
                                            message: warns.join('<br>'),
                                            buttons: Ext.Msg.OK,
                                        });
                                    }
                                    dlg.close();

                                    // Fire-and-forget lvm-scan on other cluster nodes
                                    Proxmox.Utils.API2Request({
                                        url: '/cluster/status',
                                        method: 'GET',
                                        success: function (cr) {
                                            (cr.result.data || [])
                                                .filter(function(n) { return n.type === 'node' && n.name !== nodename; })
                                                .forEach(function (n) {
                                                    Proxmox.Utils.API2Request({
                                                        url: '/nodes/' + n.name + '/iscsi/lvm-scan',
                                                        method: 'POST',
                                                    });
                                                });
                                        },
                                    });
                                },
                                failure: function (r) {
                                    dlg.setLoading(false);
                                    Ext.Msg.alert(gettext('Error'), r.htmlStatus);
                                },
                            });
                        },
                    },
                    {
                        text: gettext('Cancel'),
                        handler: function () { dlg.close(); },
                    },
                ],
            });
            dlg.show();
        };

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
                {
                    text: gettext('Configure Multipath'),
                    iconCls: 'fa fa-link',
                    itemId: 'iscsiConfigMpBtn',
                    disabled: true,
                    handler: function () {
                        var sel = sessionsGrid.getSelection();
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
                        var sel = sessionsGrid.getSelection();
                        if (!sel.length) return;
                        var target_iqn = sel[0].get('target_iqn');
                        var portal = sel[0].get('portal');

                        // Get WWID/alias for this session to pre-fill fields
                        Proxmox.Utils.API2Request({
                            url: '/nodes/' + nodename + '/iscsi/multipath/wwid',
                            method: 'GET',
                            params: { target_iqn: target_iqn, portal: portal },
                            success: function (response) {
                                var d = response.result.data;
                                if (!d.wwid) {
                                    Ext.Msg.show({
                                        title: gettext('Add LVM Storage'),
                                        icon: Ext.Msg.WARNING,
                                        message: gettext('No multipath device found for this target. Configure Multipath first.'),
                                        buttons: Ext.Msg.OK,
                                    });
                                    return;
                                }
                                var alias = d.existing_alias || d.wwid;
                                showAddLvmDialog(alias);
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
                url: '/nodes/' + nodename + '/iscsi/multipath/config',
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

Ext.define('PVE.node.FCPanel', {
    extend: 'Ext.panel.Panel',
    xtype: 'pveNodeFCPanel',

    layout: {
        type: 'hbox',
        align: 'stretch',
    },

    initComponent: function () {
        var me = this;
        var nodename = me.pveSelNode.data.node;
        if (!nodename) throw 'no node name specified';

        var hbasStore = Ext.create('Ext.data.Store', {
            fields: ['name', 'port_name', 'node_name', 'port_state', 'speed', 'symbolic_name'],
            proxy: {
                type: 'proxmox',
                url: '/api2/json/nodes/' + nodename + '/iscsi/fc/hbas',
            },
        });

        var targetsStore = Ext.create('Ext.data.Store', {
            fields: ['port_name', 'node_name', 'hba', 'port_state'],
            proxy: {
                type: 'proxmox',
                url: '/api2/json/nodes/' + nodename + '/iscsi/fc/targets',
            },
        });

        var reload = function () {
            hbasStore.load();
            targetsStore.load();
        };

        var rescan = function () {
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

        var stateRenderer = function (v) {
            var color = (v === 'Online') ? '#2c9142' : '#cc2a2a';
            return '<span style="color:' + color + '">' + Ext.String.htmlEncode(v || '') + '</span>';
        };

        var fcTargetsGrid = Ext.create('Ext.grid.Panel', {
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
                        var sel = fcTargetsGrid.getSelection();
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

Ext.define('PVE.dc.ISCSISetupWizard', {
    extend: 'PVE.window.Wizard',
    xtype: 'pveDCISCSISetupWizard',

    title: gettext('SAN Setup Wizard'),
    width: 720,
    height: 550,

    // Track logins performed by this wizard session for rollback on Back
    _wizardLogins: null,

    initComponent: function () {
        var me = this;
        me._wizardLogins = [];

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
                    url: '/nodes/' + node + '/iscsi/status',
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
                        if (d.fc_hba_count > 0) {
                            detail += ' \u00b7 FC: ' + d.fc_hbas_online + '/' + d.fc_hba_count + ' HBAs online';
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
            url: '/cluster/status',
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
            fields: ['target_iqn', 'portal', 'selected', 'already_connected', 'transport'],
            data: [],
        });

        // Step 4 data (populated after login transition)
        var wwidsStore = Ext.create('Ext.data.Store', {
            fields: ['wwid', 'alias', 'is_new', 'target_iqn'],
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
                    title: gettext('iSCSI Portals'),
                    xtype: 'panel',
                    itemId: 'step2',
                    layout: { type: 'vbox', align: 'stretch' },
                    items: [
                        {
                            xtype: 'displayfield',
                            value: gettext('Leave empty on FC-only hosts \u2014 FC targets are detected automatically.'),
                            margin: '5 5 0 5',
                        },
                        {
                            xtype: 'grid',
                            itemId: 'portalsGrid',
                            flex: 1,
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
                                '-',
                                {
                                    text: gettext('Load from existing sessions'),
                                    iconCls: 'fa fa-download',
                                    handler: function () {
                                        var checkedNodes = [];
                                        nodeStatusStore.each(function (r) {
                                            if (r.get('checked')) checkedNodes.push(r.get('node'));
                                        });
                                        if (!checkedNodes.length) {
                                            Ext.Msg.show({
                                                title: gettext('Load Portals'),
                                                icon: Ext.Msg.WARNING,
                                                message: gettext('No nodes selected in step 1.'),
                                                buttons: Ext.Msg.OK,
                                            });
                                            return;
                                        }
                                        var pending = checkedNodes.length;
                                        var added = 0;
                                        checkedNodes.forEach(function (node) {
                                            Proxmox.Utils.API2Request({
                                                url: '/nodes/' + node + '/iscsi/sessions',
                                                method: 'GET',
                                                success: function (r) {
                                                    (r.result.data || []).forEach(function (s) {
                                                        var p = (s.portal || '').replace(/,\d+$/, '');
                                                        if (!p.match(/:/)) p += ':3260';
                                                        if (p && !portalsStore.findRecord('portal', p, 0, false, false, true)) {
                                                            portalsStore.add({ portal: p });
                                                            added++;
                                                        }
                                                    });
                                                    pending--;
                                                    if (pending === 0 && added === 0) {
                                                        Ext.Msg.show({
                                                            title: gettext('Load Portals'),
                                                            icon: Ext.Msg.INFO,
                                                            message: gettext('No new portals found in existing sessions.'),
                                                            buttons: Ext.Msg.OK,
                                                        });
                                                    }
                                                },
                                                failure: function () { pending--; },
                                            });
                                        });
                                    },
                                },
                            ],
                        },
                    ],
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
                            { text: gettext('Target'),    dataIndex: 'target_iqn', flex: 2 },
                            { text: gettext('Transport'), dataIndex: 'transport',  width: 70 },
                            { text: gettext('Portal'),    dataIndex: 'portal',     flex: 1 },
                        ],
                    }],
                    tbar: [{
                        text: gettext('Scan for Targets'),
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

                            targetsStore.removeAll();
                            var seen = {};
                            var addTargets = function (items) {
                                items.forEach(function (t) {
                                    if (t.already_connected) return;
                                    if (!seen[t.target_iqn]) {
                                        seen[t.target_iqn] = true;
                                        targetsStore.add(t);
                                    } else if (t.portal) {
                                        // Same target advertised by an additional portal — append it
                                        var rec = targetsStore.findRecord('target_iqn', t.target_iqn, 0, false, false, true);
                                        if (rec) {
                                            var existing = rec.get('portal') || '';
                                            if (existing.indexOf(t.portal) === -1) {
                                                rec.set('portal', existing ? existing + ', ' + t.portal : t.portal);
                                            }
                                        }
                                    }
                                });
                            };

                            // FC targets — always attempt; returns empty list if no HBAs
                            Proxmox.Utils.API2Request({
                                url: '/nodes/' + firstNode + '/iscsi/fc/targets',
                                method: 'GET',
                                success: function (response) {
                                    addTargets((response.result.data || []).map(function (t) {
                                        return {
                                            target_iqn:        t.port_name,
                                            portal:            '',
                                            transport:         'FC',
                                            selected:          true,
                                            already_connected: false,
                                        };
                                    }));
                                },
                            });

                            // iSCSI targets — only if portals were entered
                            var portals = portalsStore.collect('portal');
                            if (portals.length > 0) {
                                var statusRec = nodeStatusStore.findRecord('node', firstNode);
                                var statusData = (statusRec && statusRec.get('_statusData')) || {};
                                var sessions = statusData.sessions || [];
                                var connectedIqns = sessions.map(function (s) { return s.target_iqn; });

                                // A target is "already configured" only if it has both a session
                                // AND a matching multipath alias. A session alone (e.g. logged in
                                // but multipath wiped) means it still needs setup.
                                var configuredAliases = {};
                                (statusData.multipath_devices || []).forEach(function (dev) {
                                    if (dev.alias) configuredAliases[dev.alias.toLowerCase()] = true;
                                });

                                Proxmox.Utils.API2Request({
                                    url: '/nodes/' + firstNode + '/iscsi/discover',
                                    method: 'POST',
                                    params: { portals: portals.join(',') },
                                    waitMsgTarget: me,
                                    success: function (response) {
                                        addTargets((response.result.data || []).map(function (t) {
                                            var hasSession = connectedIqns.includes(t.target_iqn);
                                            var iqnSuffix = t.target_iqn.split(':').pop().toLowerCase();
                                            var hasAlias = !!configuredAliases[iqnSuffix];
                                            return {
                                                target_iqn:        t.target_iqn,
                                                portal:            t.portal,
                                                transport:         'iSCSI',
                                                selected:          true,
                                                already_connected: hasSession && hasAlias,
                                            };
                                        }));
                                    },
                                    failure: function (r) {
                                        Ext.Msg.alert(gettext('Error'), r.htmlStatus);
                                    },
                                });
                            }
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
                                { text: 'WWID', dataIndex: 'wwid', flex: 2 },
                                {
                                    text: gettext('Target'),
                                    dataIndex: 'target_iqn',
                                    flex: 1,
                                    renderer: function (v) {
                                        if (!v) return '';
                                        var parts = v.split(':');
                                        return Ext.String.htmlEncode(parts[parts.length - 1]);
                                    },
                                },
                                {
                                    text: gettext('Alias'),
                                    dataIndex: 'alias',
                                    flex: 1,
                                    xtype: 'widgetcolumn',
                                    widget: {
                                        xtype: 'textfield',
                                        allowBlank: false,
                                        listeners: {
                                            blur: function (field) {
                                                var rec = field.getWidgetRecord();
                                                if (rec) {
                                                    rec.set('alias', field.getValue());
                                                }
                                            },
                                        },
                                    },
                                },
                            ],
                            store: wwidsStore,
                        },
                    ],
                },

                // --- Step 5: LVM Storage ---
                {
                    title: gettext('LVM Storage'),
                    xtype: 'panel',
                    itemId: 'step5',
                    bodyPadding: 10,
                    layout: { type: 'vbox', align: 'stretch' },
                    items: [
                        {
                            xtype: 'proxmoxcheckbox',
                            itemId: 'chkSkipLvm',
                            boxLabel: gettext('Skip LVM setup'),
                            value: false,
                            listeners: {
                                change: function (cb, val) {
                                    var step = cb.up('#step5');
                                    step.down('#lvmPrimaryNode').setDisabled(val);
                                    step.down('#lvmDevice').setDisabled(val);
                                    step.down('#lvmVgName').setDisabled(val);
                                    step.down('#lvmStorageId').setDisabled(val);
                                },
                            },
                        },
                        {
                            xtype: 'displayfield',
                            fieldLabel: gettext('Device'),
                            itemId: 'lvmDevice',
                            labelWidth: 110,
                        },
                        {
                            xtype: 'combobox',
                            fieldLabel: gettext('Primary Node'),
                            itemId: 'lvmPrimaryNode',
                            labelWidth: 110,
                            store: { fields: ['node'], data: [] },
                            displayField: 'node',
                            valueField: 'node',
                            editable: false,
                            allowBlank: false,
                        },
                        {
                            xtype: 'textfield',
                            fieldLabel: gettext('VG Name'),
                            itemId: 'lvmVgName',
                            labelWidth: 110,
                            allowBlank: false,
                            regex: /^\S+$/,
                            regexText: gettext('No spaces allowed'),
                        },
                        {
                            xtype: 'textfield',
                            fieldLabel: gettext('Storage ID'),
                            itemId: 'lvmStorageId',
                            labelWidth: 110,
                            allowBlank: false,
                            regex: /^\S+$/,
                            regexText: gettext('No spaces allowed'),
                        },
                    ],
                },

                // --- Step 6: Services ---
                {
                    title: gettext('Services'),
                    xtype: 'panel',
                    itemId: 'step6',
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

                // --- Step 7: Apply ---
                {
                    title: gettext('Apply'),
                    xtype: 'panel',
                    itemId: 'step7',
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

        // Apply step: run setup on each node sequentially (called when entering step7)
        var startApply = function () {
            var nodes = [];
            nodeStatusStore.each(function (r) { if (r.get('checked')) nodes.push(r.get('node')); });

            var targets = [];
            targetsStore.each(function (r) {
                if (r.get('selected') && r.get('transport') !== 'FC') {
                    targets.push(r.get('target_iqn'));
                }
            });

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
                        merge_multipath:  1,
                        enable_lvmlockd:  enableLvmlockd ? 1 : 0,
                        enable_sanlock:   enableSanlock  ? 1 : 0,
                    },
                    success: function (response) {
                        var upid = response.result.data;
                        var logArea = section.down('#log-' + node);
                        var poll = setInterval(function () {
                            Proxmox.Utils.API2Request({
                                url: '/nodes/' + node + '/tasks/' + encodeURIComponent(upid) + '/log',
                                method: 'GET',
                                params: { start: 0, limit: 500 },
                                success: function (r) {
                                    var lines = (r.result.data || []).map(l => l.t).join('\n');
                                    logArea.setValue(lines);
                                },
                            });
                            Proxmox.Utils.API2Request({
                                url: '/nodes/' + node + '/tasks/' + encodeURIComponent(upid) + '/status',
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

            // Wrap runNextNode so LVM setup runs after all per-node setup completes
            var _origRunNextNode = runNextNode;
            runNextNode = function (idx) {
                if (idx >= nodes.length) {
                    var skipLvm = me.down('#chkSkipLvm') && me.down('#chkSkipLvm').getValue();
                    if (skipLvm) {
                        container.add({ xtype: 'displayfield', value: '<b>' + gettext('All nodes complete.') + '</b>', margin: '10 0 0 0' });
                        return;
                    }
                    var primaryNode = me.down('#lvmPrimaryNode') && me.down('#lvmPrimaryNode').getValue();
                    var device = me.down('#lvmDevice') && me.down('#lvmDevice').getValue();
                    var vgName = me.down('#lvmVgName') && me.down('#lvmVgName').getValue();
                    var storageId = me.down('#lvmStorageId') && me.down('#lvmStorageId').getValue();

                    if (!primaryNode || !device || !vgName || !storageId) {
                        container.add({ xtype: 'displayfield', value: '<b style="color:red;">' + gettext('LVM setup skipped: missing required fields (primary node, device, VG name, or storage ID).') + '</b>', margin: '10 0 0 0' });
                        return;
                    }

                    // Strip '/dev/mapper/' prefix to get bare device name
                    var deviceName = device.replace(/^\/dev\/mapper\//, '');

                    // Guard against sentinel device value (set when no new WWID was configured)
                    if (!deviceName || /[\s()]/.test(deviceName)) {
                        container.add({ xtype: 'displayfield', value: '<b style="color:red;">' + gettext('LVM setup skipped: no valid device configured. Use Skip LVM setup or configure a multipath device first.') + '</b>', margin: '10 0 0 0' });
                        return;
                    }

                    var lvmSection = Ext.create('Ext.panel.Panel', {
                        title: gettext('LVM Storage'),
                        collapsible: true,
                        bodyPadding: 5,
                        items: [{ xtype: 'textarea', readOnly: true, height: 80,
                                  fieldStyle: 'font-family: monospace; font-size: 11px;',
                                  itemId: 'lvm-log' }],
                    });
                    container.add(lvmSection);
                    var log = lvmSection.down('#lvm-log');

                    Proxmox.Utils.API2Request({
                        url: '/nodes/' + primaryNode + '/iscsi/lvm-setup',
                        method: 'POST',
                        params: { device: deviceName, vg_name: vgName, storage_id: storageId },
                        success: function (r) {
                            var d = r.result.data;
                            var msgs = [];
                            if (d.pv_existed)      msgs.push(gettext('Warning: PV already existed on') + ' /dev/mapper/' + deviceName + ' — skipped pvcreate');
                            if (d.vg_existed)      msgs.push(gettext('Warning: VG') + ' ' + vgName + ' ' + gettext('already existed — skipped vgcreate'));
                            if (d.storage_existed) msgs.push(gettext('Warning: Storage') + ' "' + storageId + '" ' + gettext('already registered — skipped'));
                            if (msgs.length) {
                                log.setValue(msgs.join('\n'));
                            } else {
                                log.setValue(gettext('PV, VG, and Proxmox storage created successfully.'));
                            }

                            // Fire-and-forget lvm-scan on non-primary nodes
                            nodes.filter(function(n) { return n !== primaryNode; }).forEach(function (n) {
                                Proxmox.Utils.API2Request({
                                    url: '/nodes/' + n + '/iscsi/lvm-scan',
                                    method: 'POST',
                                    failure: function (r) {
                                        log.setValue(log.getValue() + '\n' + gettext('Warning: lvm-scan failed on') + ' ' + n + ': ' + r.htmlStatus);
                                    },
                                });
                            });

                            container.add({ xtype: 'displayfield', value: '<b>' + gettext('All nodes complete.') + '</b>', margin: '10 0 0 0' });
                        },
                        failure: function (r) {
                            log.setValue('ERROR: ' + r.htmlStatus);
                            container.add({ xtype: 'displayfield', value: '<b style="color:red;">' + gettext('Apply finished with errors — LVM setup failed.') + '</b>', margin: '10 0 0 0' });
                        },
                    });
                    return;
                }
                _origRunNextNode(idx);
            };

            runNextNode(0);
        };

        me.callParent();

        // PVE.window.Wizard uses a #wizcontent tabpanel with no custom events.
        // Hook beforetabchange to handle async transitions and apply triggering.
        var tp = me.down('#wizcontent');
        if (tp) {
            var _skipNextTabChange = false;

            tp.on('beforetabchange', function (panel, newTab, oldTab) {
                if (_skipNextTabChange) {
                    _skipNextTabChange = false;
                    return true;
                }

                var allTabs = panel.items.items;
                var oldIdx = allTabs.indexOf(oldTab);
                var newIdx = allTabs.indexOf(newTab);
                var goingForward = newIdx > oldIdx;

                // step3 → step4 (forward): login selected targets then navigate
                if (goingForward && oldTab.itemId === 'step3') {
                    var nodes = [];
                    nodeStatusStore.each(function (r) {
                        if (r.get('checked')) nodes.push(r.get('node'));
                    });
                    if (!nodes.length) {
                        Ext.Msg.alert(gettext('Error'), gettext('Select at least one node.'));
                        return false;
                    }

                    var iscsiTargets = [];
                    var fcTargets = [];
                    targetsStore.each(function (r) {
                        if (r.get('selected') && !r.get('already_connected')) {
                            if (r.get('transport') === 'FC') {
                                fcTargets.push({ wwpn: r.get('target_iqn') });
                            } else {
                                iscsiTargets.push(r.get('target_iqn'));
                            }
                        }
                    });
                    var portals = portalsStore.collect('portal');
                    var firstNode = nodes[0];

                    // Login to iSCSI targets not already connected, then query each
                    // target's WWID directly. This works for both freshly-logged-in
                    // and pre-existing sessions (no before/after diff needed).
                    var loginPromises = [];
                    iscsiTargets.forEach(function (iqn) {
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
                        var store = me.down('#wwidsGrid').getStore();
                        store.removeAll();

                        var totalPending = iscsiTargets.length + fcTargets.length;

                        if (totalPending === 0) {
                            _skipNextTabChange = true;
                            panel.setActiveTab(newTab);
                            return;
                        }

                        var checkDone = function () {
                            totalPending--;
                            if (totalPending === 0) {
                                _skipNextTabChange = true;
                                panel.setActiveTab(newTab);
                            }
                        };

                        // iSCSI: try each portal in sequence per target
                        function tryPortalsForTarget(iqn, portalList, portalIdx) {
                            if (portalIdx >= portalList.length) {
                                // All portals exhausted for this target — no WWID found
                                checkDone();
                                return;
                            }
                            Proxmox.Utils.API2Request({
                                url: '/nodes/' + firstNode + '/iscsi/multipath/wwid',
                                method: 'GET',
                                params: { target_iqn: iqn, portal: portalList[portalIdx] },
                                success: function (r3) {
                                    var d = r3.result.data;
                                    var wwid = d && d.wwid;
                                    if (wwid && !store.findRecord('wwid', wwid, 0, false, false, true)) {
                                        store.add({
                                            wwid: wwid,
                                            alias: d.existing_alias || '',
                                            is_new: true,
                                            target_iqn: iqn,
                                        });
                                        checkDone();
                                    } else if (wwid) {
                                        // Found but duplicate — count done
                                        checkDone();
                                    } else {
                                        // No WWID from this portal — try next
                                        tryPortalsForTarget(iqn, portalList, portalIdx + 1);
                                    }
                                },
                                failure: function () {
                                    // This portal failed — try next
                                    tryPortalsForTarget(iqn, portalList, portalIdx + 1);
                                },
                            });
                        }

                        iscsiTargets.forEach(function (iqn) {
                            tryPortalsForTarget(iqn, portals, 0);
                        });

                        // FC: single direct lookup per target (no portal concept)
                        fcTargets.forEach(function (fc) {
                            Proxmox.Utils.API2Request({
                                url: '/nodes/' + firstNode + '/iscsi/multipath/wwid',
                                method: 'GET',
                                params: { fc_wwpn: fc.wwpn },
                                success: function (r3) {
                                    var d = r3.result.data;
                                    var wwid = d && d.wwid;
                                    if (wwid && !store.findRecord('wwid', wwid, 0, false, false, true)) {
                                        store.add({
                                            wwid: wwid,
                                            alias: d.existing_alias || '',
                                            is_new: true,
                                            target_iqn: fc.wwpn,
                                        });
                                    }
                                    checkDone();
                                },
                                failure: function () {
                                    checkDone();
                                },
                            });
                        });
                    });

                    return false;
                }

                // step4 → step3 (back): roll back logins this wizard performed
                if (!goingForward && oldTab.itemId === 'step4') {
                    me._wizardLogins.forEach(function (login) {
                        Proxmox.Utils.API2Request({
                            url: '/nodes/' + login.node + '/iscsi/logout',
                            method: 'POST',
                            params: { target_iqn: login.iqn, portal: login.portal },
                        });
                    });
                    me._wizardLogins = [];
                }

                // step4 → step5 (forward): populate LVM step fields from wwidsGrid alias
                if (goingForward && oldTab.itemId === 'step4') {
                    var newAlias = null;
                    me.down('#wwidsGrid').getStore().each(function (r) {
                        if (r.get('is_new') && !newAlias) newAlias = r.get('alias');
                    });

                    var step5 = me.down('#step5');
                    if (newAlias) {
                        step5.down('#lvmDevice').setValue('/dev/mapper/' + newAlias);
                        step5.down('#lvmVgName').setValue(newAlias + '-vg');
                        step5.down('#lvmStorageId').setValue(newAlias);
                        step5.down('#chkSkipLvm').setValue(false);
                    } else {
                        step5.down('#lvmDevice').setValue('(no new WWID configured)');
                        step5.down('#chkSkipLvm').setValue(true);
                    }

                    // Populate primary node combobox from checked nodes
                    var nodeList = [];
                    nodeStatusStore.each(function (r) {
                        if (r.get('checked')) nodeList.push({ node: r.get('node') });
                    });
                    var combo = step5.down('#lvmPrimaryNode');
                    combo.getStore().loadData(nodeList);
                    if (nodeList.length) combo.setValue(nodeList[0].node);
                }

                // step5 → step6 (forward): validate LVM fields and pre-populate service checkboxes
                if (goingForward && oldTab.itemId === 'step5') {
                    var skipLvm5 = me.down('#chkSkipLvm').getValue();
                    if (!skipLvm5) {
                        var lvmVgName = me.down('#lvmVgName');
                        var lvmStorageId = me.down('#lvmStorageId');
                        if (!lvmVgName.isValid() || !lvmStorageId.isValid()) {
                            return false;
                        }
                        var primaryNodeVal = me.down('#lvmPrimaryNode').getValue();
                        if (!primaryNodeVal) {
                            Ext.Msg.show({
                                title: gettext('LVM Storage'),
                                icon: Ext.Msg.WARNING,
                                message: gettext('Please select a primary node for LVM setup.'),
                                buttons: Ext.Msg.OK,
                            });
                            return false;
                        }
                    }
                    var checkedNodeCount = 0;
                    nodeStatusStore.each(function (r) { if (r.get('checked')) checkedNodeCount++; });
                    var isCluster = checkedNodeCount > 1;
                    me.down('#chkLvmlockd').setValue(isCluster);
                    me.down('#chkSanlock').setValue(isCluster);
                }

                // step6 → step7 (forward): start apply process
                if (goingForward && oldTab.itemId === 'step6') {
                    startApply();
                }
            });
        }
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

// Inject iSCSI and Multipath tabs into the node Config panel (storage group).
// Must override PVE.panel.Config (not PVE.node.Config) so we can push into
// me.items before PVE.panel.Config.initComponent builds the navigation tree.
Ext.define(null, {
    override: 'PVE.panel.Config',

    initComponent: function () {
        var me = this;

        if (me.$className === 'PVE.node.Config') {
            var caps = Ext.state.Manager.get('GuiCap');
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
