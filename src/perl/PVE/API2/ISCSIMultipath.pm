package PVE::API2::ISCSIMultipath;

use strict;
use warnings;

use PVE::JSONSchema qw(get_standard_option);
use PVE::RPCEnvironment;

use base qw(PVE::RESTHandler);

# Parse output of: iscsiadm -m session -P 0
# e.g.: tcp: [1] 192.168.122.15:3260,1 iqn.2005-10...:target (non-flash)
sub parse_sessions {
    my ($output) = @_;
    my @sessions;
    for my $line (split /\n/, $output) {
        if ($line =~ /^\w+:\s+\[\d+\]\s+(\S+?),\d+\s+(\S+)/) {
            push @sessions, {
                portal     => $1,
                target_iqn => $2,
                state      => 'LOGGED_IN',
            };
        }
    }
    return \@sessions;
}

# Parse output of: iscsiadm -m discovery -t sendtargets -p <portal>
# e.g.: 192.168.122.15:3260,1 iqn.2005-10...:target
sub parse_discovery {
    my ($output) = @_;
    my @targets;
    for my $line (split /\n/, $output) {
        if ($line =~ /^(\S+?):(\d+),(\d+)\s+(\S+)/) {
            push @targets, {
                portal     => "$1:$2",
                tpgt       => $3,
                target_iqn => $4,
            };
        }
    }
    return \@targets;
}

# Parse output of: multipath -ll
sub parse_multipath_status {
    my ($output) = @_;
    my @devices;
    my $current;
    for my $line (split /\n/, $output) {
        if ($line =~ /^(\S+)\s+\(([^)]+)\)\s+dm-\d+/) {
            push @devices, $current if $current;
            $current = { alias => $1, wwid => $2, paths => 0, state => 'unknown' };
        }
        elsif ($current && $line =~ /status=(\w+)/) {
            $current->{state} = $1;
        }
        elsif ($current && $line =~ /[|`]-\s+\d+:\d+:\d+:\d+\s+\S+\s+\S+\s+(\w+)/) {
            $current->{paths}++;
        }
    }
    push @devices, $current if $current;
    return \@devices;
}

# Merge new {wwid, alias} entries into an existing multipath.conf string.
# Inserts new multipath{} blocks inside the multipaths{} section.
# If no multipaths{} section exists, appends one.
sub merge_multipath_config {
    my ($existing, $new_entries) = @_;
    my $new_blocks = '';
    for my $entry (@$new_entries) {
        $new_blocks .= sprintf(
            "    multipath {\n        wwid %s\n        alias %s\n    }\n",
            $entry->{wwid}, $entry->{alias}
        );
    }
    if ($existing =~ /multipaths\s*\{/) {
        $existing =~ s/(multipaths\s*\{)((?:[^{}]*|\{[^{}]*\})*)(\})/$1$2$new_blocks$3/s;
    } else {
        $existing .= "\nmultipaths {\n$new_blocks}\n";
    }
    return $existing;
}

# Thin wrapper around system commands — can be mocked in tests
sub _run_cmd {
    my ($cmd, %opts) = @_;
    require PVE::Tools;
    PVE::Tools::run_command($cmd, %opts);
}

sub check_package_installed {
    my ($pkg) = @_;
    my $status = '';
    eval { _run_cmd(['dpkg-query', '-W', '-f=${Status}', $pkg],
                    outfunc => sub { $status .= $_[0] },
                    errfunc => sub {}) };
    return !$@ && $status =~ /install ok installed/;
}

sub check_service_active {
    my ($service) = @_;
    eval { _run_cmd(['systemctl', 'is-active', '--quiet', $service],
                    outfunc => sub {}, errfunc => sub {}) };
    return !$@;
}

sub check_service_enabled {
    my ($service) = @_;
    eval { _run_cmd(['systemctl', 'is-enabled', '--quiet', $service],
                    outfunc => sub {}, errfunc => sub {}) };
    return !$@;
}

__PACKAGE__->register_method({
    name        => 'status',
    path        => 'status',
    method      => 'GET',
    description => 'Get iSCSI and multipath status for this node.',
    permissions => { check => ['perm', '/nodes/{node}', ['Sys.Audit']] },
    parameters  => {
        additionalProperties => 0,
        properties => {
            node => get_standard_option('pve-node'),
        },
    },
    returns => { type => 'object' },
    code => sub {
        my ($param) = @_;

        my %pkgs;
        for my $p (qw(open-iscsi multipath-tools lvm2 sanlock)) {
            (my $key = $p) =~ s/-/_/g;
            $pkgs{$key} = check_package_installed($p) ? 1 : 0;
        }

        my %svcs;
        for my $s (qw(iscsid multipathd lvmlockd sanlock)) {
            $svcs{$s} = {
                running => check_service_active($s)  ? 1 : 0,
                enabled => check_service_enabled($s) ? 1 : 0,
            };
        }

        my $session_out = '';
        eval { _run_cmd(['iscsiadm', '-m', 'session', '-P', '0'],
                        outfunc => sub { $session_out .= $_[0] . "\n" },
                        errfunc => sub {}) };
        my $sessions = parse_sessions($session_out);

        my $mp_out = '';
        eval { _run_cmd(['multipath', '-ll'],
                        outfunc => sub { $mp_out .= $_[0] . "\n" },
                        errfunc => sub {}) };
        my $mp_devices = parse_multipath_status($mp_out);

        return {
            packages              => \%pkgs,
            services              => \%svcs,
            sessions              => $sessions,
            multipath_config_exists => (-f '/etc/multipath.conf') ? 1 : 0,
            multipath_devices     => $mp_devices,
        };
    },
});

1;
