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
