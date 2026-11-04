// Relaunch helper for the move from the Electron build.
//
// Electron installs update through Squirrel.Mac. After replacing the app
// bundle, Squirrel's ShipIt relaunches the app by running
//   <app>/Contents/Frameworks/Squirrel.framework/Resources/ShipIt ___launch___ <app>
// from the *new* bundle. The Tauri build ships this stand-in at that path so
// the one-time Electron -> Tauri update reopens the app like any other update.
// It only ever opens an .app bundle through LaunchServices.
#include <string.h>
#include <unistd.h>

static int is_app_path(const char *s) {
  size_t n = strlen(s);
  while (n > 0 && s[n - 1] == '/') n--;
  return n > 4 && strncmp(s + n - 4, ".app", 4) == 0;
}

int main(int argc, char **argv) {
  for (int i = argc - 1; i > 0; i--) {
    if (is_app_path(argv[i])) {
      execl("/usr/bin/open", "open", argv[i], (char *)0);
      return 1;
    }
  }
  return 0;
}
