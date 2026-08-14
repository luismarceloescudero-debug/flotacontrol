/**
 * OBSOLETO — el Dashboard y la vista de Equipos se unificaron en `panel.js`.
 *
 * Este archivo quedaba con lógica duplicada (calculaba totales por su cuenta, con reglas
 * que habían divergido de analyzer.js) y con un bug que rompía la vista entera:
 * usaba `statusClass`/`statusMsg` sin declararlas.
 * Se mantiene solo como re-export para no romper imports viejos.
 */
export { renderPanel as renderCards } from './panel.js';
