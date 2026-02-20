package PVE::API2::ISCSIMultipath;

use strict;
use warnings;

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

1;
