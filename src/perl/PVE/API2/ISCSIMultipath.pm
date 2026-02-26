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

# Parse FC HBA info from sysfs.
# $base defaults to /sys/class/fc_host; pass a temp dir in tests.
sub parse_fc_hbas {
    my ($base) = @_;
    $base //= '/sys/class/fc_host';
    my @hbas;
    for my $host_path (glob "$base/host*") {
        my $name = (split m{/}, $host_path)[-1];
        my %hba = (name => $name);
        for my $attr (qw(port_name node_name port_state port_type speed symbolic_name)) {
            if (open my $fh, '<', "$host_path/$attr") {
                local $/;
                ($hba{$attr} = <$fh>) =~ s/\s+$//;
                close $fh;
            } else {
                $hba{$attr} = '';
            }
        }
        push @hbas, \%hba;
    }
    return \@hbas;
}

# Parse FC fabric targets from sysfs, filtered to FCP Target role only.
# $base defaults to /sys/class/fc_remote_ports; pass a temp dir in tests.
sub parse_fc_targets {
    my ($base) = @_;
    $base //= '/sys/class/fc_remote_ports';
    my @targets;
    for my $rport_path (glob "$base/rport-*") {
        my $roles = '';
        if (open my $fh, '<', "$rport_path/roles") {
            local $/;
            ($roles = <$fh>) =~ s/\s+$//;
            close $fh;
        }
        next unless $roles =~ /FCP Target/i;

        my %target;
        for my $attr (qw(port_name node_name port_state)) {
            if (open my $fh, '<', "$rport_path/$attr") {
                local $/;
                ($target{$attr} = <$fh>) =~ s/\s+$//;
                close $fh;
            } else {
                $target{$attr} = '';
            }
        }
        # Extract host number from rport name: rport-H:B-I → hostH
        my $rport_name = (split m{/}, $rport_path)[-1];
        my ($host_num) = ($rport_name =~ /^rport-(\d+):/);
        $target{hba} = defined $host_num ? "host$host_num" : '';
        push @targets, \%target;
    }
    return \@targets;
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

        my $fc_hbas   = parse_fc_hbas();
        my $fc_online = scalar grep { $_->{port_state} eq 'Online' } @$fc_hbas;

        return {
            packages              => \%pkgs,
            services              => \%svcs,
            sessions              => $sessions,
            multipath_config_exists => (-f '/etc/multipath.conf') ? 1 : 0,
            multipath_devices     => $mp_devices,
            fc_hba_count          => scalar @$fc_hbas,
            fc_hbas_online        => $fc_online,
        };
    },
});


__PACKAGE__->register_method({
    name        => 'discover',
    path        => 'discover',
    method      => 'POST',
    description => 'Run iSCSI target discovery against one or more portals.',
    permissions => { check => ['perm', '/nodes/{node}', ['Sys.Modify']] },
    parameters  => {
        additionalProperties => 0,
        properties => {
            node    => get_standard_option('pve-node'),
            portals => {
                type        => 'string',
                description => 'Comma-separated list of portal IPs (optionally with :port)',
            },
        },
    },
    returns => { type => 'array', items => { type => 'object' } },
    code => sub {
        my ($param) = @_;
        my @portals = split /,/, $param->{portals};
        my @all_targets;
        for my $portal (@portals) {
            $portal =~ s/^\s+|\s+$//g;
            $portal .= ':3260' unless $portal =~ /:\d+$/;
            my $out = '';
            eval {
                _run_cmd(['iscsiadm', '-m', 'discovery', '-t', 'sendtargets', '-p', $portal],
                         outfunc => sub { $out .= $_[0] . "\n" },
                         errfunc => sub {});
            };
            push @all_targets, @{parse_discovery($out)};
        }
        my %seen;
        return [grep { !$seen{"$_->{target_iqn}|$_->{portal}"}++ } @all_targets];
    },
});

__PACKAGE__->register_method({
    name        => 'sessions',
    path        => 'sessions',
    method      => 'GET',
    description => 'List active iSCSI sessions.',
    permissions => { check => ['perm', '/nodes/{node}', ['Sys.Audit']] },
    parameters  => {
        additionalProperties => 0,
        properties => { node => get_standard_option('pve-node') },
    },
    returns => { type => 'array', items => { type => 'object' } },
    code => sub {
        my ($param) = @_;
        my $out = '';
        eval { _run_cmd(['iscsiadm', '-m', 'session', '-P', '0'],
                        outfunc => sub { $out .= $_[0] . "\n" },
                        errfunc => sub {}) };
        return parse_sessions($out);
    },
});

__PACKAGE__->register_method({
    name        => 'login',
    path        => 'login',
    method      => 'POST',
    description => 'Login to an iSCSI target on a portal. No-ops if already connected.',
    permissions => { check => ['perm', '/nodes/{node}', ['Sys.Modify']] },
    parameters  => {
        additionalProperties => 0,
        properties => {
            node       => get_standard_option('pve-node'),
            target_iqn => { type => 'string', description => 'Target IQN' },
            portal     => { type => 'string', description => 'Portal IP:port' },
        },
    },
    returns => { type => 'object', properties => {
        already_connected => { type => 'boolean' },
    }},
    code => sub {
        my ($param) = @_;
        my $out = '';
        eval { _run_cmd(['iscsiadm', '-m', 'session', '-P', '0'],
                        outfunc => sub { $out .= $_[0] . "\n" },
                        errfunc => sub {}) };
        my $sessions = parse_sessions($out);
        for my $s (@$sessions) {
            if ($s->{target_iqn} eq $param->{target_iqn} &&
                $s->{portal} eq $param->{portal}) {
                return { already_connected => 1 };
            }
        }
        _run_cmd(['iscsiadm', '-m', 'node',
                  '-T', $param->{target_iqn},
                  '-p', $param->{portal},
                  '--login']);
        return { already_connected => 0 };
    },
});

__PACKAGE__->register_method({
    name        => 'logout',
    path        => 'logout',
    method      => 'POST',
    description => 'Logout from an iSCSI target on a portal.',
    permissions => { check => ['perm', '/nodes/{node}', ['Sys.Modify']] },
    parameters  => {
        additionalProperties => 0,
        properties => {
            node       => get_standard_option('pve-node'),
            target_iqn => { type => 'string' },
            portal     => { type => 'string' },
        },
    },
    returns => { type => 'null' },
    code => sub {
        my ($param) = @_;
        _run_cmd(['iscsiadm', '-m', 'node',
                  '-T', $param->{target_iqn},
                  '-p', $param->{portal},
                  '--logout']);
        return undef;
    },
});

__PACKAGE__->register_method({
    name        => 'set_startup',
    path        => 'startup',
    method      => 'PUT',
    description => 'Set auto-login mode for an iSCSI target.',
    permissions => { check => ['perm', '/nodes/{node}', ['Sys.Modify']] },
    parameters  => {
        additionalProperties => 0,
        properties => {
            node       => get_standard_option('pve-node'),
            target_iqn => { type => 'string' },
            portal     => { type => 'string' },
            mode       => {
                type => 'string',
                enum => ['automatic', 'manual', 'onboot'],
            },
        },
    },
    returns => { type => 'null' },
    code => sub {
        my ($param) = @_;
        _run_cmd(['iscsiadm', '-m', 'node',
                  '-T', $param->{target_iqn},
                  '-p', $param->{portal},
                  '--op', 'update',
                  '-n', 'node.startup',
                  '-v', $param->{mode}]);
        return undef;
    },
});

__PACKAGE__->register_method({
    name        => 'fc_hbas',
    path        => 'fc/hbas',
    method      => 'GET',
    description => 'List local Fibre Channel HBAs from sysfs.',
    permissions => { check => ['perm', '/nodes/{node}', ['Sys.Audit']] },
    parameters  => {
        additionalProperties => 0,
        properties => { node => get_standard_option('pve-node') },
    },
    returns => { type => 'array', items => { type => 'object' } },
    code => sub {
        my ($param) = @_;
        return parse_fc_hbas();
    },
});

__PACKAGE__->register_method({
    name        => 'fc_targets',
    path        => 'fc/targets',
    method      => 'GET',
    description => 'List FC fabric targets visible through local HBAs.',
    permissions => { check => ['perm', '/nodes/{node}', ['Sys.Audit']] },
    parameters  => {
        additionalProperties => 0,
        properties => { node => get_standard_option('pve-node') },
    },
    returns => { type => 'array', items => { type => 'object' } },
    code => sub {
        my ($param) = @_;
        return parse_fc_targets();
    },
});

__PACKAGE__->register_method({
    name        => 'fc_rescan',
    path        => 'fc/rescan',
    method      => 'POST',
    description => 'Trigger LIP (fabric re-enumeration) on all local FC HBAs.',
    permissions => { check => ['perm', '/nodes/{node}', ['Sys.Modify']] },
    parameters  => {
        additionalProperties => 0,
        properties => { node => get_standard_option('pve-node') },
    },
    returns => { type => 'null' },
    code => sub {
        my ($param) = @_;
        for my $host_path (glob '/sys/class/fc_host/host*') {
            if (open my $fh, '>', "$host_path/issue_lip") {
                print $fh "1";
                close $fh;
            }
        }
        return undef;
    },
});

__PACKAGE__->register_method({
    name        => 'multipath_status',
    path        => 'multipath/status',
    method      => 'GET',
    description => 'Get current multipath device status.',
    permissions => { check => ['perm', '/nodes/{node}', ['Sys.Audit']] },
    parameters  => {
        additionalProperties => 0,
        properties => { node => get_standard_option('pve-node') },
    },
    returns => { type => 'array', items => { type => 'object' } },
    code => sub {
        my ($param) = @_;
        my $out = '';
        eval { _run_cmd(['multipath', '-ll'],
                        outfunc => sub { $out .= $_[0] . "\n" },
                        errfunc => sub {}) };
        return parse_multipath_status($out);
    },
});

__PACKAGE__->register_method({
    name        => 'get_multipath_config',
    path        => 'multipath/config',
    method      => 'GET',
    description => 'Get current /etc/multipath.conf content.',
    permissions => { check => ['perm', '/nodes/{node}', ['Sys.Audit']] },
    parameters  => {
        additionalProperties => 0,
        properties => { node => get_standard_option('pve-node') },
    },
    returns => { type => 'object', properties => { content => { type => 'string' } } },
    code => sub {
        my ($param) = @_;
        my $content = '';
        if (-f '/etc/multipath.conf') {
            open my $fh, '<', '/etc/multipath.conf'
                or die "Cannot read /etc/multipath.conf: $!\n";
            local $/;
            $content = <$fh>;
            close $fh;
        }
        return { content => $content };
    },
});

__PACKAGE__->register_method({
    name        => 'put_multipath_config',
    path        => 'multipath/config',
    method      => 'PUT',
    description => 'Write /etc/multipath.conf and restart multipathd.',
    permissions => { check => ['perm', '/nodes/{node}', ['Sys.Modify']] },
    parameters  => {
        additionalProperties => 0,
        properties => {
            node    => get_standard_option('pve-node'),
            content => { type => 'string', description => 'Full multipath.conf content' },
            merge   => {
                type        => 'boolean',
                optional    => 1,
                default     => 0,
                description => 'Merge new entries into existing config instead of replacing',
            },
        },
    },
    returns => { type => 'string', description => 'UPID of the restart task' },
    code => sub {
        my ($param) = @_;
        my $rpcenv   = PVE::RPCEnvironment::get();
        my $authuser = $rpcenv->get_user();
        my $content  = $param->{content};

        if ($param->{merge} && -f '/etc/multipath.conf') {
            open my $fh, '<', '/etc/multipath.conf'
                or die "Cannot read existing config: $!\n";
            local $/;
            my $existing = <$fh>;
            close $fh;
            $content = $existing . "\n" . $content;
        }

        my $final_content = $content;
        return $rpcenv->fork_worker('mpconfig', undef, $authuser, sub {
            print "Writing /etc/multipath.conf...\n";
            open my $fh, '>', '/etc/multipath.conf'
                or die "Cannot write /etc/multipath.conf: $!\n";
            print $fh $final_content;
            close $fh;
            print "Restarting multipathd...\n";
            _run_cmd(['systemctl', 'restart', 'multipathd']);
            print "Done.\n";
        });
    },
});


sub session_exists {
    my ($sessions, $target_iqn, $portal) = @_;
    for my $s (@$sessions) {
        return 1 if $s->{target_iqn} eq $target_iqn && $s->{portal} eq $portal;
    }
    return 0;
}

sub lvm_conf_has_lvmlockd {
    my ($content) = @_;
    return $content =~ /use_lvmlockd\s*=\s*1/;
}

__PACKAGE__->register_method({
    name        => 'setup',
    path        => 'setup',
    method      => 'POST',
    description => 'Run full iSCSI/multipath setup sequence. Idempotent.',
    permissions => { check => ['perm', '/nodes/{node}', ['Sys.Modify']] },
    parameters  => {
        additionalProperties => 0,
        properties => {
            node             => get_standard_option('pve-node'),
            portals          => { type => 'string', description => 'Comma-separated portals' },
            targets          => { type => 'string', description => 'Comma-separated target IQNs' },
            multipath_config => { type => 'string', description => 'Full multipath.conf content' },
            merge_multipath  => { type => 'boolean', optional => 1, default => 0 },
            enable_lvmlockd  => { type => 'boolean', optional => 1, default => 0 },
            enable_sanlock   => { type => 'boolean', optional => 1, default => 0 },
        },
    },
    returns => { type => 'string', description => 'UPID' },
    code => sub {
        my ($param) = @_;
        my $rpcenv   = PVE::RPCEnvironment::get();
        my $authuser = $rpcenv->get_user();

        my @portals = map { my $p = $_; $p =~ s/^\s+|\s+$//g; $p =~ /:/ ? $p : "$p:3260" }
                      split(/,/, $param->{portals});
        my @targets = map { my $t = $_; $t =~ s/^\s+|\s+$//g; $t }
                      split(/,/, $param->{targets});

        return $rpcenv->fork_worker('iscsisetup', undef, $authuser, sub {
            # Step 1: Install missing packages
            print "Checking packages...\n";
            my @missing;
            push @missing, 'open-iscsi'      unless check_package_installed('open-iscsi');
            push @missing, 'multipath-tools' unless check_package_installed('multipath-tools');
            push @missing, 'lvm2'            unless check_package_installed('lvm2');
            push @missing, 'sanlock'         if $param->{enable_sanlock}
                                             && !check_package_installed('sanlock');
            if (@missing) {
                print "Installing: @missing\n";
                _run_cmd(['apt-get', 'install', '-y', @missing]);
            } else {
                print "All packages already installed - skipped.\n";
            }

            # Step 2: Enable iscsid
            print "Checking iscsid...\n";
            if (!check_service_active('iscsid')) {
                _run_cmd(['systemctl', 'enable', '--now', 'iscsid']);
                print "iscsid enabled and started.\n";
            } else {
                print "iscsid already running - skipped.\n";
            }

            # Step 3: Discovery + login
            my $session_out = '';
            eval { _run_cmd(['iscsiadm', '-m', 'session', '-P', '0'],
                            outfunc => sub { $session_out .= $_[0] . "\n" },
                            errfunc => sub {}) };
            my $existing_sessions = parse_sessions($session_out);

            for my $portal (@portals) {
                print "Discovering targets on $portal...\n";
                eval { _run_cmd(['iscsiadm', '-m', 'discovery',
                                 '-t', 'sendtargets', '-p', $portal],
                                outfunc => sub { print "  $_[0]\n" },
                                errfunc => sub {}) };
            }

            for my $target (@targets) {
                for my $portal (@portals) {
                    if (session_exists($existing_sessions, $target, $portal)) {
                        print "Already connected: $target on $portal - skipped.\n";
                    } else {
                        print "Logging in: $target on $portal...\n";
                        eval { _run_cmd(['iscsiadm', '-m', 'node',
                                         '-T', $target, '-p', $portal, '--login'],
                                        outfunc => sub { print "  $_[0]\n" },
                                        errfunc => sub { print "  $_[0]\n" }) };
                        warn "  Warning: $@" if $@;
                    }
                }
            }

            # Step 4: Write multipath.conf
            print "Configuring multipath...\n";
            my $config = $param->{multipath_config};
            if ($param->{merge_multipath} && -f '/etc/multipath.conf') {
                open my $fh, '<', '/etc/multipath.conf'
                    or die "Cannot read existing multipath.conf: $!\n";
                local $/;
                my $existing = <$fh>;
                close $fh;
                $config = $existing . "\n" . $config;
                print "Merged with existing config.\n";
            }
            open my $fh, '>', '/etc/multipath.conf'
                or die "Cannot write /etc/multipath.conf: $!\n";
            print $fh $config;
            close $fh;
            print "multipath.conf written.\n";

            # Step 5: Enable multipathd
            if (!check_service_active('multipathd')) {
                _run_cmd(['systemctl', 'enable', '--now', 'multipathd']);
                print "multipathd enabled and started.\n";
            } else {
                _run_cmd(['systemctl', 'restart', 'multipathd']);
                print "multipathd restarted with new config.\n";
            }

            # Step 6: lvmlockd/sanlock (optional)
            if ($param->{enable_lvmlockd}) {
                print "Configuring lvmlockd...\n";
                open my $lf, '<', '/etc/lvm/lvm.conf'
                    or die "Cannot read lvm.conf: $!\n";
                my $lvm_conf;
                { local $/; $lvm_conf = <$lf>; }
                close $lf;

                if (!lvm_conf_has_lvmlockd($lvm_conf)) {
                    $lvm_conf =~ s/(global\s*\{)/$1\n    use_lvmlockd = 1/;
                    open my $lf2, '>', '/etc/lvm/lvm.conf'
                        or die "Cannot write lvm.conf: $!\n";
                    print $lf2 $lvm_conf;
                    close $lf2;
                    print "lvm.conf updated.\n";
                } else {
                    print "lvmlockd already in lvm.conf - skipped.\n";
                }
                _run_cmd(['systemctl', 'enable', '--now', 'lvmlockd'])
                    unless check_service_active('lvmlockd');
            }

            if ($param->{enable_sanlock}) {
                _run_cmd(['systemctl', 'enable', '--now', 'sanlock'])
                    unless check_service_active('sanlock');
            }

            # Step 7: Configure auto-login
            print "Configuring auto-login...\n";
            for my $target (@targets) {
                for my $portal (@portals) {
                    eval {
                        _run_cmd(['iscsiadm', '-m', 'node',
                                  '-T', $target, '-p', $portal,
                                  '--op', 'update',
                                  '-n', 'node.startup', '-v', 'automatic'],
                                 errfunc => sub {});
                    };
                }
            }

            print "Setup complete.\n";
        });
    },
});

1;
