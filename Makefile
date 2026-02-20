PACKAGE=pve-iscsi-multipath
VERSION=0.1.0
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
	prove -lv t/

deb:
	dpkg-buildpackage -us -uc -b
