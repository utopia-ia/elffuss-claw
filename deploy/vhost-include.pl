#!/usr/bin/perl
# SPDX-License-Identifier: Apache-2.0
# Copyright (c) 2026 UtopiaIA
#
# Prints a vhost with the security-headers snippet included where nginx needs it, without touching the file:
#   - in every `server { … }` block whose server_name lists one of the given names and that listens on 443 (ssl);
#   - in every `location … { … }` of those blocks that has an add_header of its own (there nginx forgets the server's
#     add_header), unless the location is listed as having its own headers (--skip, e.g. ^~ /memory/).
# A line that already includes the snippet is left alone, so running it twice changes nothing.
#
#   perl deploy/vhost-include.pl --snippet snippets/claw.elffuss.com.headers.report-only.conf \
#        --name claw.elffuss.com --skip '^~ /memory/' /etc/nginx/sites-available/<vhost> > /tmp/vhost.new
#   diff -u /etc/nginx/sites-available/<vhost> /tmp/vhost.new      # review, then copy over and nginx -t
#
# To switch phase later, replace the snippet's name (…headers.report-only.conf → …headers.conf) with sed.
use strict; use warnings;
my ($snippet, @names, @skip);
while (@ARGV && $ARGV[0] =~ /^--/) {
  my $o = shift @ARGV;
  if ($o eq '--snippet') { $snippet = shift @ARGV }
  elsif ($o eq '--name') { push @names, shift @ARGV }
  elsif ($o eq '--skip') { push @skip, shift @ARGV }
  else { die "unknown option $o\n" }
}
die "usage: vhost-include.pl --snippet <path> --name <server_name> [--skip <location>] <vhost>\n" unless $snippet && @names && @ARGV == 1;
local $/; my $text = <>;
my $base = $snippet; $base =~ s{^.*/}{}; $base =~ s/\.headers(\.report-only)?\.conf$//;
my $already = qr/^\s*include\s+\S*\Q$base\E\.headers(?:\.report-only)?\.conf\s*;/m;

# Find blocks by brace depth: [start of keyword, position of '{', position after matching '}'].
sub blocks {
  my ($t, $kw, $from, $to) = @_;
  my @out;
  pos($t) = $from;
  while ($t =~ /(^|\n)([ \t]*)(\Q$kw\E\b[^{;]*)\{/g) {
    my $open = pos($t) - 1; last if $open >= $to;
    my ($d, $i) = (0, $open);
    for (; $i < length $t; $i++) { my $c = substr($t, $i, 1); $d++ if $c eq '{'; if ($c eq '}') { $d--; last if !$d } }
    push @out, [$open - length($3) - length($2), $open, $i + 1, $2, $3];
    pos($t) = $i + 1;
  }
  return @out;
}
my @inserts;   # [position after '{', indent]
for my $s (blocks($text, 'server', 0, length $text)) {
  my ($st, $open, $end, $ind) = @$s;
  my $body = substr($text, $open + 1, $end - $open - 2);
  next unless $body =~ /\blisten\b[^;]*\b(443|ssl)\b/;
  my ($sn) = $body =~ /\bserver_name\s+([^;]+);/; next unless $sn;
  my %have = map { $_ => 1 } split /\s+/, $sn;
  next unless grep { $have{$_} } @names;
  # Only the server's own top level is checked for an existing include (not its locations').
  my $top = $body; $top =~ s/\blocation\b[^{]*\{(?:[^{}]|\{[^{}]*\})*\}//g;
  push @inserts, [$open + 1, "$ind    "] unless $top =~ $already;
  for my $l (blocks($text, 'location', $open + 1, $end)) {
    my ($lst, $lopen, $lend, $lind, $head) = @$l;
    next if $lend > $end;
    (my $h = $head) =~ s/^location\s+//; $h =~ s/\s+$//;
    next if grep { $h eq $_ } @skip;
    my $lbody = substr($text, $lopen + 1, $lend - $lopen - 2);
    next unless $lbody =~ /\badd_header\b/;
    next if $lbody =~ $already;
    push @inserts, [$lopen + 1, "$lind    "];
  }
}
for my $p (sort { $b->[0] <=> $a->[0] } @inserts) {
  my $rest = substr($text, $p->[0], 1) eq "\n" ? '' : "\n$p->[1]";   # a one-line block goes on the next line
  substr($text, $p->[0], 0) = "\n$p->[1]include $snippet;  # Elffuss F0 security headers$rest";
}
print $text;
print STDERR "vhost-include: " . scalar(@inserts) . " include(s) added\n";
