import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import {optionalBarSettings} from '../optionalBarSettings.js';

function check(condition, message) {
    if (!condition)
        throw new Error(message);
}

function fixture(root, marker, {extension = true, key = true, type = 'b'} = {}) {
    const directory = extension
        ? `${root}/gnome-shell/extensions/ohno-bar@ohnoibrokeit.dev/schemas` : root;
    GLib.mkdir_with_parents(directory, 0o700);
    GLib.file_set_contents(`${directory}/bar.gschema.xml`, `
        <schemalist><schema id="org.gnome.shell.extensions.ohno-bar"
          path="/org/gnome/shell/extensions/ohno-bar/">
          ${key ? `<key name="performance-mode" type="${type}"><default>${type === 'b' ? 'false' : "''"}</default></key>` : ''}
          <key name="test-location" type="s"><default>'${marker}'</default></key>
        </schema></schemalist>`);
    const [, , stderr, status] = GLib.spawn_sync(null,
        ['glib-compile-schemas', directory], null, GLib.SpawnFlags.SEARCH_PATH, null);
    check(status === 0, `schema fixture failed: ${new TextDecoder().decode(stderr)}`);
    return directory;
}

function removeTree(file) {
    if (file.query_file_type(Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS, null) === Gio.FileType.DIRECTORY) {
        const entries = file.enumerate_children('standard::name', Gio.FileQueryInfoFlags.NONE, null);
        try {
            let entry;
            while ((entry = entries.next_file(null)))
                removeTree(file.get_child(entry.get_name()));
        } finally {
            entries.close(null);
        }
    }
    file.delete(null);
}

check(GLib.getenv('GSETTINGS_BACKEND') === 'memory', 'run with GSETTINGS_BACKEND=memory');
const root = GLib.dir_make_tmp('ohno-optional-settings-XXXXXX');
try {
    const userDataDir = `${root}/user`;
    const systemDataDirs = [`${root}/system`];
    const options = {userDataDir, systemDataDirs, defaultSource: null};
    check(optionalBarSettings(options) === null, 'missing Bar should be optional');
    fixture(systemDataDirs[0], 'system');
    check(optionalBarSettings(options).get_string('test-location') === 'system',
        'system-installed extension schema was not found');
    fixture(userDataDir, 'user');
    check(optionalBarSettings(options).get_string('test-location') === 'user',
        'user installation should precede system installation');
    fixture(`${root}/selected/schemas`, 'selected', {extension: false});
    check(optionalBarSettings({...options, extensionPath: `${root}/selected`})
        .get_string('test-location') === 'selected', 'selected extension path should take precedence');

    fixture(`${root}/old`, 'old', {key: false});
    check(optionalBarSettings({userDataDir: `${root}/old`, systemDataDirs: [], defaultSource: null}) === null,
        'older schema without performance-mode should be optional');
    fixture(`${root}/wrong-type`, 'wrong-type', {type: 's'});
    check(optionalBarSettings({userDataDir: `${root}/wrong-type`, systemDataDirs: [], defaultSource: null}) === null,
        'incompatible performance-mode type should be optional');
    const corrupt = `${root}/corrupt/gnome-shell/extensions/ohno-bar@ohnoibrokeit.dev/schemas`;
    GLib.mkdir_with_parents(corrupt, 0o700);
    GLib.file_set_contents(`${corrupt}/gschemas.compiled`, 'not a schema');
    check(optionalBarSettings({...options, userDataDir: `${root}/corrupt`})
        .get_string('test-location') === 'system', 'corrupt optional schema should not block discovery');

    const globalDirectory = fixture(`${root}/global`, 'global', {extension: false});
    const defaultSource = Gio.SettingsSchemaSource.new_from_directory(globalDirectory, null, false);
    check(optionalBarSettings({userDataDir: null, systemDataDirs: [], defaultSource})
        .get_string('test-location') === 'global', 'globally installed schema fallback was not found');
    print('PASS optional Bar settings: absent, system, user, selected, older, incompatible, corrupt and default source');
} finally {
    removeTree(Gio.File.new_for_path(root));
}
