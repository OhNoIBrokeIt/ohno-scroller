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
    const row = new Adw.SpinRow({
        title,
        subtitle,
        adjustment: new Gtk.Adjustment({
            lower,
            upper,
            step_increment: step,
            page_increment: step * 5,
        }),
    });

    settings.bind(key, row, 'value', Gio.SettingsBindFlags.DEFAULT);
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

        const shortcutsGroup = new Adw.PreferencesGroup({
            title: 'Shortcuts',
            description: 'Change these with gsettings for now; a shortcut recorder can come later.',
        });
        page.add(shortcutsGroup);

        for (const [title, key] of [
            ['Toggle tiling', 'toggle-tiling'],
            ['Retile workspace', 'retile-workspace'],
            ['Equalize split ratios', 'equalize-ratios'],
            ['Focus column left', 'focus-column-left'],
            ['Focus column right', 'focus-column-right'],
            ['Focus tile above', 'focus-up'],
            ['Focus tile below', 'focus-down'],
            ['Move window left', 'move-window-left'],
            ['Move window right', 'move-window-right'],
            ['Move window up', 'move-window-up'],
            ['Move window down', 'move-window-down'],
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
