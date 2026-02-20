package PVE::JSONSchema;
use strict;
use warnings;
use Exporter 'import';
our @EXPORT_OK = qw(get_standard_option);
sub get_standard_option {
    my ($name) = @_;
    return { type => 'string', description => $name };
}
1;
