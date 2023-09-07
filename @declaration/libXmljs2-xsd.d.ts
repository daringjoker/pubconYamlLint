declare module 'libxmljs2-xsd'{
    type schema={
        validate:(k:string)=>[any]
    }

     export var parseFile:(path:string)=>schema
    export var libxmljs:{
        parseXml:(k:string)=>Record<string, any>
    }

}

