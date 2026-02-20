package PVE::RPCEnvironment;
use strict;
use warnings;
sub get { bless {}, shift }
sub get_user { return 'root@pam' }
sub fork_worker { die "fork_worker not available in tests\n" }
1;
