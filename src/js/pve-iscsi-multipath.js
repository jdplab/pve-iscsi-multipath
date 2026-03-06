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
