import Darwin

// fd 3 is opened and checked by the trusted host. Keep its flock across exec:
// there is no supervisor whose death can release a live worker's lock.
let arguments = Array(CommandLine.arguments.dropFirst())
guard arguments.count >= 2, arguments[0].hasPrefix("/") else { exit(64) }
var info = stat()
guard fstat(3, &info) == 0, (info.st_mode & S_IFMT) == S_IFREG,
      info.st_uid == getuid(), info.st_nlink == 1,
      (info.st_mode & 0o077) == 0, info.st_size == 0 else { exit(77) }
guard flock(3, LOCK_EX | LOCK_NB) == 0 else { exit(75) }
let flags = fcntl(3, F_GETFD)
guard flags >= 0, fcntl(3, F_SETFD, flags & ~FD_CLOEXEC) == 0 else { exit(71) }
let argv = arguments.map { strdup($0) } + [nil]
argv.withUnsafeBufferPointer { buffer in
    _ = execv(arguments[0], buffer.baseAddress!)
}
exit(71)
