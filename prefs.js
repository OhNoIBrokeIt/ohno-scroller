import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

function addSwitch(group, settings, key, title, subtitle = null) {
    const row = new Adw.SwitchRow({title, subtitle});
    settings.bind(key, row, 'active', Gio.SettingsBindFlags.DEFAULT);
    group.add(row);
}

function addSpin(group, settings, key, title, lower, upper, step, subtitle = null) {
    const adjustment = new Gtk.Adjustment({
        lower,
        upper,
        step_increment: step,
        page_increment: step * 5,
    });
    const spin = new Gtk.SpinButton({
        adjustment,
        numeric: true,
        valign: Gtk.Align.CENTER,
    });
    const row = new Adw.ActionRow({
        title,
        subtitle,
        activatable_widget: spin,
    });

    spin.set_value(settings.get_int(key));
    spin.connect('value-changed', () => {
        settings.set_int(key, spin.get_value_as_int());
    });
    settings.connect(`changed::${key}`, () => {
        if (spin.get_value_as_int() !== settings.get_int(key))
            spin.set_value(settings.get_int(key));
    });

    row.add_suffix(spin);
    group.add(row);
}

export default class OhNoScrollerPrefs extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        const page = new Adw.PreferencesPage({
            title: 'Tiling',
            icon_name: 'view-grid-symbolic',
        });

        const layoutGroup = new Adw.PreferencesGroup({
            title: 'Layout',
        });
        page.add(layoutGroup);

        addSwitch(layoutGroup, settings, 'tiling-enabled', 'Manage windows');
        addSpin(layoutGroup, settings, 'gap-size', 'Gap size', 0, 64, 1, 'Pixels between windows and columns.');
        addSpin(layoutGroup, settings, 'column-width-percent', 'Column width', 25, 100, 5, 'Percent of monitor width used by each column.');

        const shortcutsGroup = new Adw.PreferencesGroup({
            title: 'Shortcuts',
            description: 'Change these with gsettings for now; a shortcut recorder can come later.',
        });
        page.add(shortcutsGroup);

        for (const [title, key] of [
            ['Toggle tiling', 'toggle-tiling'],
            ['Retile workspace', 'retile-workspace'],
            ['Focus column left', 'focus-column-left'],
            ['Focus column right', 'focus-column-right'],
            ['Move window left', 'move-window-left'],
            ['Move window right', 'move-window-right'],
            ['Move window to new column', 'move-window-new-column'],
        ]) {
            const row = new Adw.ActionRow({
                title,
                subtitle: settings.get_strv(key).join(', '),
            });
            shortcutsGroup.add(row);
        }

        window.add(page);
    }
}
