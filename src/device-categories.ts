/** Category capabilities for IR/RF remotes; not a claim of physical state feedback. */
export const deviceCategories = {
 tv: {label:'TV', service:'Switch'},
 'set-top-box': {label:'Set-top Box', service:'Switch'},
 'smart-tv-box': {label:'Smart TV Box', service:'Switch'},
 bulb: {label:'Bulb', service:'Lightbulb'},
 'led-strip': {label:'LED Strip Light', service:'Lightbulb'},
 dvd: {label:'DVD', service:'Switch'},
 audio: {label:'Audio', service:'Switch'},
 amplifier: {label:'Amplifier', service:'Switch'},
 projector: {label:'Projector', service:'Switch'},
 switch: {label:'Switch', service:'Switch'},
 curtain: {label:'Curtain', service:'WindowCovering'},
 'roller-shutter': {label:'Roller shutter', service:'WindowCovering'},
 door: {label:'Door', service:'Door'},
 heater: {label:'Heater', service:'Switch'},
 humidifier: {label:'Humidifier', service:'Switch'},
 'ac-simple': {label:'AC Remote Simple Type', service:'Switch'},
 'air-purifier': {label:'Air purifier', service:'Switch'},
 'sweeping-robot': {label:'Sweeping robot', service:'Switch'},
 'clothes-hanger': {label:'Clothes hanger', service:'WindowCovering'},
 camera: {label:'Camera', service:'Switch'},
 userdefine: {label:'UserDefine', service:'Switch'},
} as const;
export type DeviceCategory=keyof typeof deviceCategories;
export interface DeviceConfig {name:string;remoteId:string;hubId:string;category:DeviceCategory;commands:Record<string,string>;}
