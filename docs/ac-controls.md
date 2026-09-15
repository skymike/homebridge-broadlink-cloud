# TCL air conditioner controls

[Back to README](../README.md)

## AC controls in Apple Home

Open the AC group to access **AC Fan Auto**, **AC Fan Low**, **AC Fan Medium**, **AC Fan High**, **AC Swing**, **AC Dry** and **AC Fan Only**. The accessory settings can show separate tiles.

Fan-speed switches select one speed: selecting another clears the previous selection; turning off the selected speed leaves it selected. Swing is an on/off setting. Temperature/mode changes preserve speed and swing. While power is off or unknown, speed/swing choices prepare the next command without operating the AC.

Dry/Fan Only turn the AC on in that mode; turning off its active mode switch sends Off. Heat/Cool/Auto clear the special-mode switches. Thermostat Off always sends Off. HomeKit Thermostat lacks Dry/Fan-only values, so its mode displays Off while the corresponding named switch is active. This TCL profile ignores target temperature in Dry/Fan-only modes. Auto fan in Fan Only mode transmits Medium speed. Timer, turbo and horizontal swing are unsupported by this profile.
