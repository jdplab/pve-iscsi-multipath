PACKAGE=pve-iscsi-multipath
VERSION=0.2.0
JS_DEST=/usr/share/pve-manager/js
PERL_DEST=/usr/share/perl5/PVE/API2

.PHONY: all install uninstall deb test

all:

install:
	install -d $(DESTDIR)$(JS_DEST)
	install -m 0644 src/js/pve-iscsi-multipath.js $(DESTDIR)$(JS_DEST)/
	install -d $(DESTDIR)$(PERL_DEST)
	install -m 0644 src/perl/PVE/API2/ISCSIMultipath.pm $(DESTDIR)$(PERL_DEST)/

test:
	PERL5LIB=t/lib prove -lv t/

deb:
	rm -rf debian/tmp
	mkdir -p debian/tmp/DEBIAN
	$(MAKE) install DESTDIR=debian/tmp
	printf 'Package: %s\nVersion: %s\nArchitecture: all\nMaintainer: Your Name <you@example.com>\nDepends: pve-manager (>= 9.0), libpve-access-control, libpve-common-perl\nRecommends: open-iscsi, multipath-tools, lvm2, sanlock\nDescription: iSCSI and Multipath configuration plugin for Proxmox VE\n Adds iSCSI and multipath management panels to the Proxmox VE web GUI,\n including a datacenter-level setup wizard.\n' $(PACKAGE) $(VERSION) > debian/tmp/DEBIAN/control
	install -m 0755 debian/postinst debian/tmp/DEBIAN/postinst
	install -m 0755 debian/prerm debian/tmp/DEBIAN/prerm
	install -m 0644 debian/triggers debian/tmp/DEBIAN/triggers
	dpkg-deb --build debian/tmp $(PACKAGE)_$(VERSION)_all.deb
	rm -rf debian/tmp
