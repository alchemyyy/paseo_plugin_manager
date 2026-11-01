# Plugin manager

Paseo plugin that lists the installed Paseo plugins in the sidebar, checks them for updates, and with one click updates plugins installed from Git checkouts to the latest commits of their upstream branch, then reloads them in Paseo.

## Install

1. Install [Paseo](https://paseo.sh) (0.13.0 or later) and [Git](https://git-scm.com), and turn on Settings > Plugins > Enable plugins.
2. Run the install script in this folder:

   ```powershell
   powershell -ExecutionPolicy Bypass -File install.ps1
   ```

   It installs the plugin with `paseo plugin install <folder>`, or runs `paseo plugin reload` if it is already installed; use it after editing the plugin. Option: `-PaseoCli <path>` points to `paseo.cmd` if it is not found automatically.
3. The **Plugins** section appears in the sidebar, above **Accounts**.

The plugin id is `git-plugin-manager` rather than `plugin-manager` because Paseo orders plugin sidebar items by plugin id until you reorder the sidebar: this id puts the section after [Better chat management](https://github.com/alchemyyy/paseo_better_chat_management)'s chats and before the [Login manager](https://github.com/alchemyyy/paseo_omp_login_manager)'s Accounts. Once Settings > Sidebar has saved an order that includes plugin items, a newly installed item goes to the end; move it there.

## Features

### Plugins sidebar section

- Header: **Plugins** with a chevron right after the title. Clicking the header shows or hides every installed plugin; the choice is remembered per host. Plugins with an update stay listed while the list is collapsed.
- Header buttons: the refresh icon checks every plugin for updates; the download icon updates every plugin (accent colored when an update is waiting). While one runs the header reads "Plugins (checking)" or "Plugins (updating)".
- One row per plugin, with a status icon: up to date (check), update available (arrow, and the row reads `<name> · 3 new commits`), checking or updating (loader), last check or update failed (alert), Paseo could not load it (cross), not tracked (dashed: a folder outside Git, a branch without an upstream, or a Paseo-managed install not checked yet).
- Row buttons: check this plugin for updates, and update and install it.
- Clicking a row opens its details: id and source, branch, upstream and commit, new commits, local commits not on the upstream, uncommitted files, when it was last checked, up to 10 incoming commit subjects, the last failure, Paseo's load error, its folder, and both actions.
- When a check or update started from the window finishes, a toast sums it up, such as "Updated Better tree (3 commits)" or "Could not update Better tree: ...". The row keeps the full reason.
- Every plugin is checked 20 seconds after Paseo starts this plugin and every 30 minutes after. The list refreshes every 60 seconds, so plugins installed elsewhere and repositories pulled in a terminal show up.

### How checks and updates work

- **Folder installs in a Git work tree** (`paseo plugin install <folder>` on a clone, such as this repository):
  - Check runs `git fetch` and compares the branch with its upstream; it never changes the work tree.
  - Update fetches, then runs `git merge --ff-only @{upstream}`. Git refuses rather than merge diverged history or overwrite uncommitted changes; the refusal shows on the row and nothing is reloaded.
  - If the new commits changed the plugin's `package.json` or `package-lock.json`, `npm ci` runs in its folder before the reload (`npm install` without a lockfile, dev dependencies included), since Paseo bundles from `node_modules` when it compiles a plugin. A failed install is retried before the plugin's next reload.
  - Then `paseo plugin reload <id>` recompiles it; open windows pick up the new version without reloading. Every installed plugin in the same repository is reloaded, since its files changed too. A disabled plugin is pulled but not reloaded; Paseo compiles the new code when it is enabled.
- **Installs Paseo manages** (`paseo plugin install` from a Git URL, the registry, or npm) are checked and updated with `paseo plugin update <id>`, which builds, validates, and restarts them.
- **Folders outside Git** have nothing to check.
- **Update all** only updates plugins with new upstream commits. A plugin's own **Update and install** also reloads it when there is nothing new, which loads local edits the same way `install.ps1` does.
- The plugin updates itself too. Its own reload runs last, from a separate process, once the summary is ready; the section disappears for a moment and returns with the new version.
- One check or update runs at a time; repositories are fetched four at a time. Git never prompts in a terminal (a credential helper's sign-in window can still appear), and status reads leave the index lock to your own Git.

## Limitations

- A folder install that fails to compile after an update stays failed, since Paseo keeps no previous build for folders; the row shows Paseo's error. Fix the plugin and use **Update and install** again, or check out the previous commit.
- Dependencies are installed only with npm.
- Paseo's plugin SDK has no API for managing plugins, so this plugin runs the `paseo` CLI (`PASEO_CLI`, which Paseo gives its plugins, else the desktop app's bundled `paseo.cmd`, else `paseo` on PATH).
- `SidebarRow` labels are plain text with no slot for a chevron, so the header draws its own row with Paseo's sidebar row measurements. It does not follow a changed interface font size.
- The window only notices a check it did not start, such as the periodic one, at its next refresh, up to 60 seconds later.
- The install script is PowerShell (Windows).
