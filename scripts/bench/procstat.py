#!/usr/bin/env python3 -I
"""Snapshot memory and CPU time for an app and every process macOS attributes
to it.

A process belongs to the app when it is the app's PID or when macOS reports
the app as its "responsible" process. That covers Electron's helper processes
(children of the main process) and WebKit's XPC services (WebContent,
Networking, GPU), which are launched by launchd rather than by the app. It is
the same attribution Activity Monitor uses.

Memory is `ri_phys_footprint`, the figure Activity Monitor shows in its
"Memory" column. CPU time is user + system time, converted from Mach ticks.

Usage: procstat.py <root-pid>   -> prints one JSON object
"""
import ctypes
import json
import subprocess
import sys

libc = ctypes.CDLL('/usr/lib/libSystem.B.dylib')
responsible = libc.responsibility_get_pid_responsible_for_pid
responsible.restype = ctypes.c_int
responsible.argtypes = [ctypes.c_int]

proc_pid_rusage = libc.proc_pid_rusage
proc_pid_rusage.restype = ctypes.c_int
proc_pid_rusage.argtypes = [ctypes.c_int, ctypes.c_int, ctypes.c_void_p]
RUSAGE_INFO_V4 = 4


class MachTimebase(ctypes.Structure):
    _fields_ = [('numer', ctypes.c_uint32), ('denom', ctypes.c_uint32)]


tb = MachTimebase()
libc.mach_timebase_info(ctypes.byref(tb))
TICK_NS = tb.numer / tb.denom

# rusage_info_v4: 16-byte uuid followed by uint64 fields.
IDX_USER, IDX_SYS = 0, 1
IDX_RESIDENT, IDX_FOOTPRINT = 6, 7
IDX_LIFETIME_MAX_FOOTPRINT = 28


def rusage(pid):
    buf = (ctypes.c_uint8 * 1024)()
    if proc_pid_rusage(pid, RUSAGE_INFO_V4, buf) != 0:
        return None
    vals = (ctypes.c_uint64 * 120).from_buffer(buf, 16)
    return {
        'cpu_ns': (vals[IDX_USER] + vals[IDX_SYS]) * TICK_NS,
        'resident': vals[IDX_RESIDENT],
        'footprint': vals[IDX_FOOTPRINT],
        'peak_footprint': vals[IDX_LIFETIME_MAX_FOOTPRINT],
    }


def main():
    root = int(sys.argv[1])
    out = subprocess.run(['ps', '-A', '-o', 'pid=,ppid=,comm='], capture_output=True, text=True).stdout
    rows = []
    for line in out.splitlines():
        parts = line.strip().split(None, 2)
        if len(parts) == 3:
            rows.append((int(parts[0]), int(parts[1]), parts[2]))
    # The app, everything macOS holds it responsible for, and its descendants.
    members = {root} | {pid for pid, _, _ in rows if responsible(pid) == root}
    grew = True
    while grew:
        grew = False
        for pid, ppid, _ in rows:
            if ppid in members and pid not in members:
                members.add(pid)
                grew = True
    procs = []
    for pid, _, comm in rows:
        if pid not in members:
            continue
        usage = rusage(pid)
        if usage is None:
            continue
        procs.append({'pid': pid, 'name': comm.rsplit('/', 1)[-1], **usage})
    total = {k: sum(p[k] for p in procs) for k in ('cpu_ns', 'resident', 'footprint', 'peak_footprint')}
    print(json.dumps({'root': root, 'count': len(procs), 'total': total, 'procs': procs}))


if __name__ == '__main__':
    main()
