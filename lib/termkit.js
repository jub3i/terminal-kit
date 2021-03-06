/*
	The Cedric's Swiss Knife (CSK) - CSK terminal toolbox
	
	Copyright (c) 2009 - 2015 Cédric Ronvel 
	
	The MIT License (MIT)

	Permission is hereby granted, free of charge, to any person obtaining a copy
	of this software and associated documentation files (the "Software"), to deal
	in the Software without restriction, including without limitation the rights
	to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
	copies of the Software, and to permit persons to whom the Software is
	furnished to do so, subject to the following conditions:

	The above copyright notice and this permission notice shall be included in all
	copies or substantial portions of the Software.

	THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
	IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
	FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
	AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
	LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
	OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
	SOFTWARE.
*/

/*
	TODO:
	- Try to detect the real terminal ($TERM report xterm most of time)
		- this command 
			basename $(ps -f -p $(cat /proc/$(echo $$)/stat | cut -d \  -f 4) | tail -1 | sed 's/^.* //')
			may help locally, but is useless remotely
		- 'CSI c' and 'CSI > c' are almost useless
	- Then use infocmp to get terminfo string
*/

// Load modules
var tree = require( 'tree-kit' ) ;
var async = require( 'async-kit' ) ;
var string = require( 'string-kit' ) ;
var punycode = require( 'punycode' ) ;

var hslConverter = require( './hslConverter.js' ) ;



var termkit = {} ;
module.exports = termkit ;



// This is used for adjustement of floating point value, before applying Math.floor()
var adjustFloor = 0.0000001 ;



termkit.Terminal = function Terminal() { throw new Error( '[terminal] Cannot create a Terminal instance directly, use terminalKit.createTerminal() instead.' ) ; } ;
termkit.Terminal.prototype = Object.create( async.EventEmitter.prototype ) ;
termkit.Terminal.prototype.constructor = termkit.Terminal ;



// Load submodules in the termkit tree
tree.extend( null , termkit , require( './detectTerminal.js' ) ) ;
tree.extend( null , termkit , require( './tty.js' ) ) ;
termkit.Rect = require( './Rect.js' ) ;
termkit.ScreenBuffer = require( './ScreenBuffer.js' ) ;
termkit.TextBuffer = require( './TextBuffer.js' ) ;
termkit.autoComplete = require( './autoComplete.js' ) ;



termkit.createTerminal = function createTerminal( createOptions )
{
	// Manage createOptions
	if ( ! createOptions )
	{
		createOptions = {
			stdin: process.stdin ,
			stdout: process.stdout ,
			stderr: process.stderr ,
			generic: 'xterm' ,
			appId: null ,
			appName: null
			// couldTTY: true
		} ;
	}
	
	if ( typeof createOptions.generic !== 'string' ) { createOptions.generic = 'xterm' ; }
	
	var termconfig ;
	var chainable = Object.create( notChainable ) ;
	var options = { on: '', off: '', params: 0, out: createOptions.stdout } ;
	
	var term = applyEscape.bind( undefined , options ) ;
	
	// Yay, this is a nasty hack...
	term.__proto__ = chainable ;	// jshint ignore:line
	term.apply = Function.prototype.apply ;
	term.call = Function.prototype.call ;
	
	// Fix the root
	options.root = term ;
	term.root = term ;
	
	term.options = options ;
	term.stdin = createOptions.stdin ;
	term.stdout = createOptions.stdout ;
	term.stderr = createOptions.stderr ;
	term.generic = createOptions.generic ;
	term.appId = createOptions.appId ;
	term.appName = createOptions.appName ;
	term.pid = createOptions.pid ;
	term.grabbing = false ;
	term.timeout = 200 ;	// 200ms timeout by default, so ssh can work without trouble
	
	// Screen size
	term.width = undefined ;
	term.height = undefined ;
	onResize.call( term ) ;
	if ( term.stdout.isTTY ) { term.stdout.on( 'resize' , onResize.bind( term ) ) ; }
	else if ( createOptions.processSigwinch ) { process.on( 'SIGWINCH' , onResize.bind( term ) ) ; }
	
	// States
	term.state = {
		button: {
			left: false,
			middle: false,
			right: false,
			other: false
		}
	} ;
	
	//term.couldTTY = true ;
	
	if ( term.appId )
	{
		// We have got the real terminal app
		try {
			term.termconfigFile = term.appId + '.js' ;
			termconfig = require( './termconfig/' + term.termconfigFile ) ;
		}
		catch ( error ) {} // Do nothing, let the next if block handle the case
	}
	
	if ( ! termconfig )
	{
		// The real terminal app is not known, or we fail to load it...
		// Fallback to the terminal generic (most of time, got from the $TERM env variable).
		try {
			// If a .generic.js file exists, this is a widely used terminal generic, 'xterm' for example.
			// We should use this generic files because despite advertising them as 'xterm',
			// most terminal sucks at being truly 'xterm' compatible (only 33% to 50% of xterm capabilities
			// are supported, even gnome-terminal and Konsole are bad).
			// So we will try to maintain a fail-safe xterm generic config.
			term.termconfigFile = term.generic + '.generic.js' ;
			termconfig = require( './termconfig/' + term.termconfigFile ) ;
		}
		catch ( error ) {
			try {
				// No generic config exists, try a specific config
				term.termconfigFile = term.generic + '.js' ;
				termconfig = require( './termconfig/' + term.termconfigFile ) ;
			}
			catch ( error ) {
				// Nothing found, fallback to the most common terminal generic
				term.termconfigFile = 'xterm.generic.js' ;
				termconfig = require( './termconfig/' + term.termconfigFile ) ;
			}
		}
	}
	
	//console.log( term.termconfigFile ) ;
	
	// if needed, this should be replaced by some tput commands?
	
	term.esc = tree.extend( { deep: true } , {} , termconfig.esc ) ;
	tree.extend( null , term.esc , pseudoEsc ) ;	// Do not use deep:true here
	term.handler = tree.extend( null , {} , termconfig.handler ) ;
	term.keymap = tree.extend( { deep: true } , {} , termconfig.keymap ) ;
	term.colorRegister = tree.extend( { deep: true } , [] , defaultColorRegister , termconfig.colorRegister ) ;
	
	term.escHandler = { root: term } ;
	term.escOffHandler = { root: term } ;
	
	// reverse keymap
	term.rKeymap = [] ;
	term.rKeymapMaxSize = -1 ;
	term.rKeymapStarter = [] ;
	term.rKeymapStarterMaxSize = -1 ;
	
	Object.keys( term.keymap ).forEach( function( key ) {
		
		var i , j , keymapObject , code , codeList = term.keymap[ key ] ;
		
		if ( ! Array.isArray( codeList ) ) { codeList = [ codeList ] ; term.keymap[ key ] = codeList ; }
		
		for ( j = 0 ; j < codeList.length ; j ++ )
		{
			code = codeList[ j ] ;
			
			if ( typeof code === 'object' )
			{
				keymapObject = code ;
				keymapObject.name = key ;
				code = keymapObject.code ;
			}
			else
			{
				keymapObject = {
					code: code ,
					name: key ,
					matches: [ key ]
				} ;
				
				term.keymap[ key ][ j ] = { code: code } ;
			}
			
			// keymap handler
			if ( keymapObject.handler && typeof keymapObject.handler !== 'function' )
			{
				term.keymap[ key ][ j ].handler = term.handler[ keymapObject.handler ] ;
			}
			
			if ( code )
			{
				if ( code.length > term.rKeymapMaxSize )
				{
					for ( i = term.rKeymapMaxSize + 1 ; i <= code.length ; i ++ ) { term.rKeymap[ i ] = {} ; }
					term.rKeymapMaxSize = code.length ;
				}
				
				if ( term.rKeymap[ code.length ][ code ] )
				{
					term.rKeymap[ code.length ][ code ].matches.push( key ) ;
				}
				else
				{
					term.rKeymap[ code.length ][ code ] = keymapObject ;
					term.rKeymap[ code.length ][ code ].matches = [ key ] ;
				}
			}
			else
			{
				if ( ! keymapObject.starter || ! keymapObject.ender || ! keymapObject.handler ) { continue ; }
				
				if ( keymapObject.starter.length > term.rKeymapStarterMaxSize )
				{
					for ( i = term.rKeymapStarterMaxSize + 1 ; i <= keymapObject.starter.length ; i ++ ) { term.rKeymapStarter[ i ] = {} ; }
					term.rKeymapStarterMaxSize = keymapObject.starter.length ;
				}
				
				if ( term.rKeymapStarter[ keymapObject.starter.length ][ keymapObject.starter ] )
				{
					term.rKeymapStarter[ keymapObject.starter.length ][ keymapObject.starter ].push( key ) ;
				}
				else
				{
					term.rKeymapStarter[ keymapObject.starter.length ][ keymapObject.starter ] = [ keymapObject ] ;
				}
			}
		}
	} ) ;
	
	
	// Create methods for the 'chainable' prototype
	
	Object.keys( term.esc ).forEach( function( key ) {
		
		// build-time resolution
		if ( typeof term.esc[ key ].on === 'function' ) { term.esc[ key ].on = term.esc[ key ].on.call( term ) ; }
		if ( typeof term.esc[ key ].off === 'function' ) { term.esc[ key ].off = term.esc[ key ].off.call( term ) ; }
		
		// dynamic handler
		if ( term.esc[ key ].handler )
		{
			if ( typeof term.esc[ key ].handler === 'function' ) { term.escHandler[ key ] = term.esc[ key ].handler ; }
			else { term.escHandler[ key ] = term.handler[ term.esc[ key ].handler ] ; }
		}
		
		// dynamic off handler
		if ( term.esc[ key ].offHandler )
		{
			if ( typeof term.esc[ key ].offHandler === 'function' ) { term.escOffHandler[ key ] = term.esc[ key ].offHandler ; }
			else { term.escOffHandler[ key ] = term.handler[ term.esc[ key ].offHandler ] ; }
		}
		
		Object.defineProperty( chainable , key , {
			configurable: true ,
			get: function () {
				var fn , options = {} ;
				
				options = tree.extend( null , {} , this.options ) ;
				
				options.on += this.root.esc[ key ].on || '' ;
				options.off = ( this.root.esc[ key ].off || '' ) + options.off ;
				options.params += string.format.count( this.root.esc[ key ].on ) ;
				
				if ( ! options.onHasFormatting &&
					( options.params ||
						( typeof this.root.esc[ key ].on === 'string' &&
							string.format.hasFormatting( this.root.esc[ key ].on ) ) ) )
				{
					options.onHasFormatting = true ;
				}
				
				if ( ! options.offHasFormatting &&
					( typeof this.root.esc[ key ].off === 'string' &&
						string.format.hasFormatting( this.root.esc[ key ].off ) ) )
				{
					options.offHasFormatting = true ;
				}
				
				if ( this.root.esc[ key ].err ) { options.err = true ; options.out = this.root.stderr ; }
				if ( this.root.esc[ key ].str ) { options.str = true ; }
				if ( this.root.esc[ key ].noFormat ) { options.noFormat = true ; }
				
				fn = applyEscape.bind( undefined , options ) ;
				
				// Yay, this is a nasty hack...
				fn.__proto__ = chainable ;	// jshint ignore:line
				fn.apply = Function.prototype.apply ;
				
				fn.root = this.root || this ;
				fn.options = options ;
				
				// Replace the getter by the newly created function, to speed up further call
				Object.defineProperty( this , key , { value: fn } ) ;
				
				//console.log( 'Create function:' , key ) ;
				
				return fn ;
			}
		} ) ;
	} ) ;
	
	createOptimized( term ) ;
	
	return term ;
} ;



// The default terminal will be lazily created
Object.defineProperty( termkit , 'terminal' , {
	configurable: true ,
	enumerable: true ,
	get: function () {
		
		var guessed = termkit.guessTerminal() ;
		var guessedTerminal = termkit.createTerminal( {
			stdin: process.stdin ,
			stdout: process.stdout ,
			stderr: process.stderr ,
			generic: process.env.TERM.toLowerCase() ,
			appId: guessed.safe ? guessed.appId : undefined ,
		//	appName: guessed.safe ? guessed.appName : undefined ,
			processSigwinch: true
			// couldTTY: true
		} ) ;
		
		Object.defineProperty( termkit , 'terminal' , { value: guessedTerminal , enumerable: true } ) ;
		
		return guessedTerminal ;
	}
} ) ;





			/* Optimized */



function createOptimized( term )
{
	// This is a subset of the terminal capability, mainly used to speed up ScreenBuffer
	var i ;
	
	term.optimized = {} ;
	
	// reset
	tree.defineLazyProperty( term.optimized , 'styleReset' , function() { return term.str.styleReset() ; } ) ;
	
	// Styles
	tree.defineLazyProperty( term.optimized , 'bold' , function() { return term.str.bold() ; } ) ;
	tree.defineLazyProperty( term.optimized , 'dim' , function() { return term.str.dim() ; } ) ;
	tree.defineLazyProperty( term.optimized , 'italic' , function() { return term.str.italic() ; } ) ;
	tree.defineLazyProperty( term.optimized , 'underline' , function() { return term.str.underline() ; } ) ;
	tree.defineLazyProperty( term.optimized , 'blink' , function() { return term.str.blink() ; } ) ;
	tree.defineLazyProperty( term.optimized , 'inverse' , function() { return term.str.inverse() ; } ) ;
	tree.defineLazyProperty( term.optimized , 'hidden' , function() { return term.str.hidden() ; } ) ;
	tree.defineLazyProperty( term.optimized , 'strike' , function() { return term.str.strike() ; } ) ;
	
	
	// Colors
	term.optimized.color256 = {} ;
	term.optimized.bgColor256 = {} ;
	
	function createColor256( index )
	{
		tree.defineLazyProperty( term.optimized.color256 , index , function() { return term.str.color256( index ) ; } ) ;
	}
	
	function createBgColor256( index )
	{
		tree.defineLazyProperty( term.optimized.bgColor256 , index , function() { return term.str.bgColor256( index ) ; } ) ;
	}
	
	for ( i = 0 ; i <= 255 ; i ++ )
	{
		createColor256( i ) ;
		createBgColor256( i ) ;
	}
	
	
	// Move To
	term.optimized.moveTo = term.esc.moveTo.optimized || term.str.moveTo ;
}





			/* Apply */



// CAUTION: 'options' MUST NOT BE OVERWRITTEN!
// It is binded at the function creation and contains function specificities!
function applyEscape( options )
{
	var onFormat = [ options.on ] , output , on , off ;
	
	var action = arguments[ 1 + options.params ] ;
	
	// If not enough arguments, return right now
	// Well... what about term.up(), term.previousLine(), and so on?
	//if ( arguments.length < 1 + options.params && ( action === null || action === false ) ) { return options.root ; }
	
	if ( options.params )
	{
		onFormat = onFormat.concat( Array.prototype.slice.call( arguments , 1 , 1 + options.params ) ) ;
	}
	
	//console.log( '\n>>> Action:' , action , '<<<\n' ) ;
	//console.log( 'Attributes:' , attributes ) ;
	if ( action === undefined || action === true )
	{
		on = options.onHasFormatting ? string.format.apply( options.root.escHandler , onFormat ) : options.on ;
		if ( options.str ) { return on ; }
		options.out.write( on ) ;
		return options.root ;
	}
	
	if ( action === null || action === false )
	{
		off = options.offHasFormatting ? string.format.call( options.root.escOffHandler , options.off ) : options.off ;
		if ( options.str ) { return off ; }
		options.out.write( off ) ;
		return options.root ;
	}
	
	if ( typeof action !== 'string' )
	{
		if ( typeof action.toString === 'function' ) { action = action.toString() ; }
		else { action = '' ; }
	}
	
	// So we have got a string
	
	on = options.onHasFormatting ? string.format.apply( options.root.escHandler , onFormat ) : options.on ;
	
	if ( arguments.length > 2 && ! options.noFormat )
	{
		action = string.format.apply(
			options.root.escHandler ,
			Array.prototype.slice.call( arguments , 1 + options.params )
		) ;
	}
	
	off = options.offHasFormatting ? string.format.call( options.root.escOffHandler , options.off ) : options.off ;
	
	output = on + action + off ;
	
	if ( options.str ) { return output ; }
	options.out.write( output ) ;
	return options.root ;
}





			/* Pseudo esc */



var pseudoEsc = {
	// It just set error:true so it will write to STDERR instead of STDOUT
	error: { err: true } ,
	
	// It just set str:true so it will not write anything, but return the value in a string
	str: { str: true } ,
	
	// It just set attr:true so it will not write anything, but return an attribute object
	attr: { attr: true } ,
	
	// It just set noFormat:true so it will not call string.format() on user input,
	// only useful for ScreenBuffer, so blit-like redraw() can perform slightly faster
	noFormat: { noFormat: true } ,
	
	move: {
		on: '%[move:%a%a]' ,
		handler: function move( x , y ) {
			
			var sequence = '' ;
			
			if ( x )
			{
				if ( x > 0 ) { sequence += string.format.call( this.root.escHandler , this.root.esc.right.on , x ) ; }
				else { sequence += string.format.call( this.root.escHandler , this.root.esc.left.on , -x ) ; }
			}
			
			if ( y )
			{
				if ( y > 0 ) { sequence += string.format.call( this.root.escHandler , this.root.esc.down.on , y ) ; }
				else { sequence += string.format.call( this.root.escHandler , this.root.esc.up.on , -y ) ; }
			}
			
			return sequence ;
		}
	} ,
	
	color: {
		on: '%[color:%a]' ,
		off: function() { return this.root.esc.defaultColor.on ; } ,
		handler: function color( c )
		{
			if ( typeof c !== 'number' ) { return '' ; }
			
			c = Math.floor( c ) ;
			
			if ( c < 0 || c > 15 ) { return '' ; }
			
			if ( c <= 7 ) { return string.format.call( this.root.escHandler , this.root.esc.darkColor.on , c ) ; }
			else { return string.format.call( this.root.escHandler , this.root.esc.brightColor.on , c - 8 ) ; }
		}
	} ,
	
	bgColor: {
		on: '%[bgColor:%a]' ,
		off: function() { return this.root.esc.bgDefaultColor.on ; } ,
		handler: function bgColor( c )
		{
			if ( typeof c !== 'number' ) { return '' ; }
			
			c = Math.floor( c ) ;
			
			if ( c < 0 || c > 15 ) { return '' ; }
			
			if ( c <= 7 ) { return string.format.call( this.root.escHandler , this.root.esc.bgDarkColor.on , c ) ; }
			else { return string.format.call( this.root.escHandler , this.root.esc.bgBrightColor.on , c - 8 ) ; }
		}
	} ,
	
	colorRgb: {
		on: '%[colorRgb:%a%a%a]' ,
		off: function() { return this.root.esc.defaultColor.on ; } ,
		handler: function colorRgb( r , g , b )
		{
			var c ;
			
			if ( typeof r !== 'number' || typeof g !== 'number' || typeof b !== 'number' ) { return '' ; }
			if ( r < 0 || r > 255 || g < 0 || g > 255 || b < 0 || b > 255 ) { return '' ; }
			
			if ( ! this.root.esc.color24bits.na && ! this.root.esc.color24bits.fb )
			{
				// The terminal supports 24bits! Yeah!
				return string.format.call( this.root.escHandler , this.root.esc.color24bits.on , r , g , b ) ;
			}
			
			if ( ! this.root.esc.color256.na && ! this.root.esc.color256.fb )
			{
				// The terminal supports 256 colors
				
				// Convert to 0..5 range
				r = Math.floor( r * 6 / 256 + adjustFloor ) ;
				g = Math.floor( g * 6 / 256 + adjustFloor ) ;
				b = Math.floor( b * 6 / 256 + adjustFloor ) ;
				
				c = Math.floor( 16 + r * 36 + g * 6 + b ) ;
				
				// min:16 max:231
				//if ( c < 16 || c > 231 ) { return '' ; }
				
				return string.format.call( this.root.escHandler , this.root.esc.color256.on , c ) ;
			}
			
			// The terminal does not support 256 colors, fallback
			c = this.root.registerForRgb( r , g , b , 0 , 15 ) ;
			return string.format.call( this.root.escHandler , this.root.esc.color.on , c ) ;
		}
	} ,
	
	bgColorRgb: {
		on: '%[bgColorRgb:%a%a%a]' ,
		off: function() { return this.root.esc.bgDefaultColor.on ; } ,
		handler: function bgColorRgb( r , g , b )
		{
			var c ;
			
			if ( typeof r !== 'number' || typeof g !== 'number' || typeof b !== 'number' ) { return '' ; }
			if ( r < 0 || r > 255 || g < 0 || g > 255 || b < 0 || b > 255 ) { return '' ; }
			
			if ( ! this.root.esc.bgColor24bits.na && ! this.root.esc.bgColor24bits.fb )
			{
				// The terminal supports 24bits! Yeah!
				return string.format.call( this.root.escHandler , this.root.esc.bgColor24bits.on , r , g , b ) ;
			}
			
			if ( ! this.root.esc.bgColor256.na && ! this.root.esc.bgColor256.fb )
			{
				// The terminal supports 256 colors
				
				// Convert to 0..5 range
				r = Math.floor( r * 6 / 256 + adjustFloor ) ;
				g = Math.floor( g * 6 / 256 + adjustFloor ) ;
				b = Math.floor( b * 6 / 256 + adjustFloor ) ;
				
				c = Math.floor( 16 + r * 36 + g * 6 + b ) ;
				
				// min:16 max:231
				//if ( c < 16 || c > 231 ) { return '' ; }
				
				return string.format.call( this.root.escHandler , this.root.esc.bgColor256.on , c ) ;
			}
			
			// The terminal does not support 256 colors, fallback
			c = this.root.registerForRgb( r , g , b , 0 , 15 ) ;
			return string.format.call( this.root.escHandler , this.root.esc.bgColor.on , c ) ;
		}
	} ,
	
	colorGrayscale: {
		on: '%[colorGrayscale:%a]' ,
		off: function() { return this.root.esc.defaultColor.on ; } ,
		handler: function colorGrayscale( g )
		{
			var c ;
			
			if ( typeof g !== 'number' ) { return '' ; }
			if ( g < 0 || g > 255 ) { return '' ; }
			
			if ( ! this.root.esc.color24bits.na && ! this.root.esc.color24bits.fb )
			{
				// The terminal supports 24bits! Yeah!
				return string.format.call( this.root.escHandler , this.root.esc.color24bits.on , g , g , g ) ;
			}
			
			if ( ! this.root.esc.color256.na && ! this.root.esc.color256.fb )
			{
				// The terminal supports 256 colors
				
				// Convert to 0..25 range
				g = Math.floor( g * 26 / 256 + adjustFloor ) ;
				
				if ( g < 0 || g > 25 ) { return '' ; }
				
				if ( g === 0 ) { c = 16 ; }
				else if ( g === 25 ) { c = 231 ; }
				else { c = g + 231 ; }
				
				return string.format.call( this.root.escHandler , this.root.esc.color256.on , c ) ;
			}
			
			// The terminal does not support 256 colors, fallback
			c = this.root.registerForRgb( g , g , g , 0 , 15 ) ;
			return string.format.call( this.root.escHandler , this.root.esc.color.on , c ) ;
		}
	} ,
	
	bgColorGrayscale: {
		on: '%[bgColorGrayscale:%a]' ,
		off: function() { return this.root.esc.bgDefaultColor.on ; } ,
		handler: function bgColorGrayscale( g )
		{
			var c ;
			
			if ( typeof g !== 'number' ) { return '' ; }
			if ( g < 0 || g > 255 ) { return '' ; }
			
			if ( ! this.root.esc.bgColor24bits.na && ! this.root.esc.bgColor24bits.fb )
			{
				// The terminal supports 24bits! Yeah!
				return string.format.call( this.root.escHandler , this.root.esc.bgColor24bits.on , g , g , g ) ;
			}
			
			if ( ! this.root.esc.bgColor256.na && ! this.root.esc.bgColor256.fb )
			{
				// Convert to 0..25 range
				//console.log( '-- ' , g , g * 26 / 256 , Math.floor( g * 26 / 256 ) , Math.floor( g * 26 / 256 + adjustFloor ) ) ;
				g = Math.floor( g * 26 / 256 + adjustFloor ) ;
				
				if ( g < 0 || g > 25 ) { return '' ; }
				
				if ( g === 0 ) { c = 16 ; }
				else if ( g === 25 ) { c = 231 ; }
				else { c = g + 231 ; }
				
				return string.format.call( this.root.escHandler , this.root.esc.bgColor256.on , c ) ;
			}
			
			// The terminal does not support 256 colors, fallback
			c = this.root.registerForRgb( g , g , g , 0 , 15 ) ;
			return string.format.call( this.root.escHandler , this.root.esc.bgColor.on , c ) ;
		}
	}
	
} ;





			/* Internal/private functions */



// Called by either SIGWINCH signal or stdout's 'resize' event.
// It is not meant to be used by end-user.
function onResize()
{
	if ( this.stdout.getWindowSize )
	{
		var windowSize = this.stdout.getWindowSize() ;
		this.width = windowSize[ 0 ] ;
		this.height = windowSize[ 1 ] ;
	}
	
	this.emit( 'terminal' , 'SCREEN_RESIZE' , { resized: true , width: this.width , height: this.height } ) ;
}





			/* Advanced methods */



// Complexes functions that cannot be chained.
// It is the ancestors of the terminal object, so it should inherit from async.EventEmitter.
var notChainable = Object.create( termkit.Terminal.prototype ) ;



// Complexes high-level features have their own file
notChainable.inputField = require( './inputField.js' ) ;
notChainable.yesOrNo = require( './yesOrNo.js' ) ;



// Fail-safe alternate screen buffer
notChainable.fullscreen = function fullscreen( options )
{
	if ( options === false )
	{
		// Disable fullscreen mode
		this.moveTo( 1 , this.height , '\n' ) ;
		this.alternateScreenBuffer( false ) ;
		return this ;
	}
	
	if ( ! options ) { options = {} ; }
	
	if ( ! options.noAlternate ) { this.alternateScreenBuffer( true ) ; }
	
	this.clear() ;
} ;





			/* Input management */



function onStdin( chunk )
{
	var i , j , buffer , startBuffer , char , codepoint ,
		keymapCode , keymapStartCode , keymap , keymapList ,
		regexp , matches , bytes , found , handlerResult ,
		index = 0 , length = chunk.length ;
	
	while ( index < length )
	{
		found = false ;
		bytes = 1 ;
		
		if ( chunk[ index ] <= 0x1f || chunk[ index ] === 0x7f )
		{
			// Those are ASCII control character and DEL key
			
			for ( i = Math.min( length , Math.max( this.rKeymapMaxSize , this.rKeymapStarterMaxSize ) ) ; i > 0 ; i -- )
			{
				buffer = chunk.slice( index ) ;
				keymapCode = buffer.toString() ;
				startBuffer = chunk.slice( index , index + i ) ;
				keymapStartCode = startBuffer.toString() ;
				
				
				if ( this.rKeymap[ i ] && this.rKeymap[ i ][ keymapStartCode ] )
				{
					// First test fixed sequences
					
					keymap = this.rKeymap[ i ][ keymapStartCode ] ;
					found = true ;
					
					if ( keymap.handler )
					{
						handlerResult = keymap.handler.call( this , keymap.name , chunk.slice( index + i ) ) ;
						bytes = i + handlerResult.eaten ;
						
						if ( ! handlerResult.disable )
						{
							this.emit( keymap.event , handlerResult.name , handlerResult.data ) ;
						}
					}
					else if ( keymap.event )
					{
						bytes = i ;
						this.emit( keymap.event , keymap.name , keymap.data , { code: startBuffer } ) ;
					}
					else
					{
						bytes = i ;
						this.emit( 'key' , keymap.name , keymap.matches , { isCharacter: false , code: startBuffer } ) ;
					}
					
					break ;
				}
				else if ( this.rKeymapStarter[ i ] && this.rKeymapStarter[ i ][ keymapStartCode ] )
				{
					// Then test pattern sequences
					
					keymapList = this.rKeymapStarter[ i ][ keymapStartCode ] ;
					
					//console.log( 'for i:' , keymapList ) ;
					
					for ( j = 0 ; j < keymapList.length ; j ++ )
					{
						keymap = keymapList[ j ] ;
						
						regexp = '^' +
							string.escape.regExp( keymap.starter ) +
							'([ -~]*)' +	// [ -~] match only all ASCII non-control character
							string.escape.regExp( keymap.ender ) ;
						
						matches = keymapCode.match( new RegExp( regexp ) , 'g' ) ;
						
						//console.log( 'for j:' , keymap , regexp , matches ) ;
						
						if ( matches )
						{
							found = true ;
							
							handlerResult = keymap.handler.call( this , keymap.name , matches[ 1 ] ) ;
							bytes = matches[ 0 ].length ;
							this.emit( keymap.event , handlerResult.name , handlerResult.data ) ;
							
							break ;
						}
					}
					
					if ( found ) { break ; }
				}
			}
			
			// Nothing was found, so to not emit trash, we just abort the current buffer processing
			if ( ! found ) { this.emit( 'unknown' , chunk ) ; return ; }
		}
		else if ( chunk[ index ] >= 0x80 )
		{
			// Unicode bytes per char guessing
			if ( chunk[ index ] < 0xc0 ) { continue ; }	// We are in a middle of an unicode multibyte sequence... Something fails somewhere, we will just continue for now...
			else if ( chunk[ index ] < 0xe0 ) { bytes = 2 ; }
			else if ( chunk[ index ] < 0xf0 ) { bytes = 3 ; }
			else if ( chunk[ index ] < 0xf8 ) { bytes = 4 ; }
			else if ( chunk[ index ] < 0xfc ) { bytes = 5 ; }
			else { bytes = 6 ; }
			
			buffer = chunk.slice( index , index.bytes ) ;
			char = buffer.toString( 'utf8' ) ;
			
			if ( bytes > 2 ) { codepoint = punycode.ucs2.decode( char )[ 0 ] ; }
			else { codepoint = char.charCodeAt( 0 ) ; }
			
			this.emit( 'key' , char , [ char ] , { isCharacter: true , codepoint: codepoint , code: buffer } ) ;
		}
		else
		{
			// Standard ASCII
			char = String.fromCharCode( chunk[ index ] ) ;
			this.emit( 'key' , char , [ char ] , { isCharacter: true , codepoint: chunk[ index ] , code: chunk[ index ] } ) ;
		}
		
		index += bytes ;
	}
}



notChainable.grabInput = function grabInput( options )
{
	if ( ! this.onStdin ) { this.onStdin = onStdin.bind( this ) ; }
	
	// RESET
	this.mouseButton.mouseDrag.mouseMotion.mouseSGR.focusEvent( false ) ;
	this.stdin.removeListener( 'data' , this.onStdin ) ;
	
	if ( options === false )
	{
		// Disable grabInput mode
		this.stdin.setRawMode( false ) ;
		this.grabbing = false ;
		return this ;
	}
	
	this.grabbing = true ;
	
	if ( ! options ) { options = {} ; }
	
	// SET
	this.stdin.setRawMode( true ) ;
	this.stdin.on( 'data' , this.onStdin ) ;
	
	if ( options.mouse )
	{
		switch ( options.mouse )
		{
			case 'button' : this.mouseButton.mouseSGR() ; break ;
			case 'drag' : this.mouseDrag.mouseSGR() ; break ;
			case 'motion' : this.mouseMotion.mouseSGR() ; break ;
		}
	}
	
	if ( options.focus ) { this.focusEvent() ; }
	
	return this ;
} ;



// A facility for those who don't want to deal with requestCursorLocation() and events...
notChainable.getCursorLocation = function getCursorLocation( callback )
{
	var self = this , wasGrabbing = this.grabbing ;
	
	if ( ! wasGrabbing ) { this.grabInput() ; }
	
	var onTerminal = function onTerminal( name , data ) {
		
		if ( name !== 'CURSOR_LOCATION' ) { return ; }
		self.removeListener( 'terminal' , onTerminal ) ;
		if ( ! wasGrabbing ) { this.grabInput( false ) ; }
		callback( undefined , data.x , data.y ) ;
	} ;
	
	this.requestCursorLocation() ;
	this.on( 'terminal' , onTerminal ) ;
} ;



// Get the RGB value for a color register
notChainable.getColor = function getColor( register , callback )
{
	// First, check capabilities:
	if ( this.esc.requestColor.na ) { callback( new Error( 'Terminal is not capable' ) ) ; return ; }
	
	var self = this , wasGrabbing = this.grabbing ;
	
	var cleanup = function( error , data ) {
		self.removeListener( 'terminal' , onTerminal ) ;
		if ( ! wasGrabbing ) { self.grabInput( false ) ; }
		
		if ( error ) { callback( error ) ; }
		else { callback( undefined , data ) ; }	//data.r , data.g , data.b ) ;
	} ;
	
	var onTerminal = function onTerminal( timeoutCallback , name , data ) {
		
		if ( name !== 'COLOR_REGISTER' ) { return ; }
		
		// We have got a color definition, but this is not for our register, so this is not our response
		if ( data.register !== register ) { return ; }
		
		// This is a good opportunity to update the color register
		if ( register < 16 ) { self.colorRegister[ register ] = { r: data.r , g: data.g , b: data.b } ; }
		
		// Everything is fine...
		timeoutCallback( undefined , data ) ;
	} ;
	
	async.callTimeout( this.timeout , cleanup , function( timeoutCallback ) {
		
		if ( ! wasGrabbing ) { self.grabInput() ; }
		
		self.requestColor( register ) ;
		self.on( 'terminal' , onTerminal.bind( undefined , timeoutCallback ) ) ;
	} ) ;
} ;



// Get the current 16 colors palette of the terminal, if possible
notChainable.getPalette = function getPalette( callback )
{
	var self = this , wasGrabbing = this.grabbing ;
	
	if ( ! wasGrabbing ) { this.grabInput() ; }
	
	// First, check capabilities, if not capable, return the default palette
	if ( this.esc.requestColor.na ) { callback( undefined , this.colorRegister.slice( 0 , 16 ) ) ; return ; }
	
	async.map(
		[ 0 , 1 , 2 , 3 , 4 , 5 , 6 , 7 , 8 , 9 , 10 , 11 , 12 , 13 , 14 , 15 ] ,
		self.getColor.bind( self )
	)
	.exec( function( error , palette ) {
		if ( ! wasGrabbing ) { self.grabInput( false ) ; }
		if ( error ) { callback( error ) ; return ; }
		callback( undefined , palette ) ;
	} ) ;
} ;



// Set the color for a register
notChainable.setColor = function setColor( register , r , g , b , names )
{
	if ( r && typeof r === 'object' )
	{
		b = r.b ;
		g = r.g ;
		r = r.r ;
		names = g ;
	}
	
	// Allow modification of register > 15 ?
	if ( typeof register !== 'number' || register < 0 || register > 15 ) { throw new Error( 'Bad register value' ) ; }
	
	if ( ! Array.isArray( names ) ) { names = [] ; }
	
	if (
		typeof r !== 'number' || r < 0 || r > 255 ||
		typeof g !== 'number' || g < 0 || g > 255 ||
		typeof b !== 'number' || b < 0 || b > 255
	)
	{
		throw new Error( 'Bad RGB value' ) ;
	}
	
	// Issue an error, or not?
	if ( this.setColorLL.na ) { return ; }
	
	// This is a good opportunity to update the color register
	this.colorRegister[ register ] = { r: r , g: g , b: b , names: names } ;
	
	// Call the Low Level set color
	this.setColorLL( register , r , g , b ) ;
} ;



// Set the current 16 colors palette of the terminal, if possible
notChainable.setPalette = function setPalette( palette )
{
	var i ;
	
	if ( typeof palette === 'string' )
	{
		try {
			palette = require( './colorScheme/' + palette + '.json' ) ;
		}
		catch( error ) {
			throw new Error( '[terminal] .setPalette(): color scheme not found: ' + palette ) ;
		}
	}
	
	if ( ! Array.isArray( palette ) ) { throw new Error( '[terminal] .setPalette(): argument #0 should be an Array of RGB Object or a built-in color scheme' ) ; }
	
	// Issue an error, or not?
	if ( this.setColorLL.na ) { return ; }
	
	for ( i = 0 ; i <= 15 ; i ++ )
	{
		if ( ! palette[ i ] || typeof palette[ i ] !== 'object' ) { continue ; }
		this.setColor( i , palette[ i ] ) ;
	}
} ;





			/* Utilities */



// Default colors, used for guessing
var defaultColorRegister = require( './colorScheme/default.json' ) ;

( function buildDefaultColorRegister()
{
	var register , offset , factor , l ;
	
	for ( register = 16 ; register < 232 ; register ++ )
	{
		// RGB 6x6x6
		offset = register - 16 ;
		factor = 255 / 5 ;
		defaultColorRegister[ register ] = {
			r: Math.floor( ( Math.floor( offset / 36 + adjustFloor ) % 6 ) * factor + adjustFloor ) ,
			g: Math.floor( ( Math.floor( offset / 6 + adjustFloor ) % 6 ) * factor + adjustFloor ) ,
			b: Math.floor( ( offset % 6 ) * factor + adjustFloor ) ,
			names: []
		} ;
	}
	
	for ( register = 232 ; register <= 255 ; register ++ )
	{
		// Grayscale 0..23
		offset = register - 231 ;	// not 232, because the first of them is not a #000000 black
		factor = 255 / 25 ;	// not 23, because the last is not a #ffffff white
		l = Math.floor( offset * factor + adjustFloor ) ;
		defaultColorRegister[ register ] = { r: l , g: l , b: l , names: [] } ;
	}
} )() ;



// If register hasn't changed, this is used to get the RGB value for them
notChainable.rgbForRegister = function rgbForRegister( register )
{
	if ( register < 0 || register > 255 ) { throw new Error( 'Bad register value' ) ; }
	
	// Simply clone it
	return {
		r: this.colorRegister[ register ].r ,
		g: this.colorRegister[ register ].g ,
		b: this.colorRegister[ register ].b
	} ;
} ;



// If register hasn't changed, this is used to get it for an RGB
// .registerForRgb( r , g , b , [minRegister] , [maxRegister] )
// .registerForRgb( rgbObject , [minRegister] , [maxRegister] )

// HSL cylender coordinate distance
notChainable.registerForRgb = function registerForRgb( r , g , b , minRegister , maxRegister , lFactor )
{
	// Manage function arguments
	
	if ( r && typeof r === 'object' )
	{
		// Manage the .registerForRgb( rgbObject , [minRegister] , [maxRegister] ) variante
		maxRegister = b ;
		minRegister = g ;
		b = r.b ;
		g = r.g ;
		r = r.r ;
	}
	
	if (
		typeof r !== 'number' || r < 0 || r > 255 ||
		typeof g !== 'number' || g < 0 || g > 255 ||
		typeof b !== 'number' || b < 0 || b > 255
	)
	{
		throw new Error( 'Bad RGB value' ) ;
	}
	
	if ( typeof maxRegister !== 'number' || maxRegister < 0 || maxRegister > 255 ) { maxRegister = 15 ; }
	if ( typeof minRegister !== 'number' || minRegister < 0 || minRegister > 255 ) { minRegister = 0 ; }
	if ( typeof lFactor !== 'number' ) { lFactor = 1 ; }
	
	if ( minRegister > maxRegister )
	{
		var tmp ;
		tmp = maxRegister ;
		maxRegister = minRegister ;
		minRegister = tmp ;
	}
	
	
	// Search for the best match
	
	// Transform HSL to cylender
	
	var x , y , z , xR , yR , zR , dx , dy , dz ,
		registerHsl , register , diff ,
		minDiff = Infinity , hsl = hslConverter.rgb2hsl( r , g , b ) ;
	
	x = hsl.s * Math.cos( hsl.h * 2 * Math.PI ) ;
	y = hsl.s * Math.sin( hsl.h * 2 * Math.PI ) ;
	z = hsl.l * lFactor ;
	
	//console.log( 'HSL:' , hsl ) ;
	
	for ( register = minRegister ; register <= maxRegister ; register ++ )
	{
		registerHsl = hslConverter.rgb2hsl( this.colorRegister[ register ] ) ;
		
		xR = registerHsl.s * Math.cos( registerHsl.h * 2 * Math.PI ) ;
		yR = registerHsl.s * Math.sin( registerHsl.h * 2 * Math.PI ) ;
		zR = registerHsl.l ;
		
		//console.log( 'Register HSL:' , registerHsl ) ;
		
		dx = Math.abs( x - xR ) ;
		dy = Math.abs( y - yR ) ;
		dz = Math.abs( z - zR ) ;
		
		diff = dx * dx + dy * dy + dz * dz ;
		
		//console.log( 'delta:' , dh , ds , dl , diff ) ;
		
		if ( diff < minDiff )
		{
			minDiff = diff ;
			minRegister = register ;
		}
	}
	
	return minRegister ;
} ;




