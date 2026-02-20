#!/usr/bin/perl
use strict;
use warnings;
use Test::More tests => 6;

use lib 'src/perl';
use lib 't/lib';
use PVE::API2::ISCSIMultipath;

# Test check_package_installed with a mock _run_cmd
{
    local *PVE::API2::ISCSIMultipath::_run_cmd = sub {
        my ($cmd, %opts) = @_;
        if (grep { $_ eq 'open-iscsi' } @$cmd) {
            $opts{outfunc}->("install ok installed") if $opts{outfunc};
            return 0;
        }
        die "not installed\n";
    };

    ok(PVE::API2::ISCSIMultipath::check_package_installed('open-iscsi'),
       'check_package_installed: installed package returns true');
    ok(!PVE::API2::ISCSIMultipath::check_package_installed('sanlock'),
       'check_package_installed: missing package returns false');
}

# Test check_service_active with a mock _run_cmd
{
    local *PVE::API2::ISCSIMultipath::_run_cmd = sub {
        my ($cmd) = @_;
        return 0 if grep { $_ eq 'iscsid' } @$cmd;
        die "inactive\n";
    };

    ok(PVE::API2::ISCSIMultipath::check_service_active('iscsid'),
       'check_service_active: active service returns true');
    ok(!PVE::API2::ISCSIMultipath::check_service_active('sanlock'),
       'check_service_active: inactive service returns false');
}

# Test check_service_enabled with a mock _run_cmd
{
    local *PVE::API2::ISCSIMultipath::_run_cmd = sub {
        my ($cmd) = @_;
        return 0 if grep { $_ eq 'multipathd' } @$cmd;
        die "disabled\n";
    };

    ok(PVE::API2::ISCSIMultipath::check_service_enabled('multipathd'),
       'check_service_enabled: enabled service returns true');
    ok(!PVE::API2::ISCSIMultipath::check_service_enabled('lvmlockd'),
       'check_service_enabled: disabled service returns false');
}
