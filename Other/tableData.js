const config = require('../config.json')
const fs = require('fs');
const axios = require('axios');
const dniTygodnia = ['niedziela', 'poniedziałek', 'wtorek', 'środa', 'czwartek', 'piątek', 'sobota'];

// zwraca daty początku i końca aktualnego tygodnia
function getDate(oneDay=false,addDays=0){
    date = new Date();
    var out = {}
    out.year=date.getFullYear()
    date.setDate(date.getDate() + addDays);

    function add0(x){ return String(x).padStart(2,'0') }

    // jeśli ma pobrać cały tydzień - bierze poniedziałek
    if (!oneDay)
        date.setDate(date.getDate() - date.getDay()+1);

    // od, do
    out.from=`${date.getFullYear()}-${add0(date.getMonth()+1)}-${add0(date.getDate())}`
    if (oneDay){ out.to = out.from }
    else{
        date.setDate(date.getDate() + 6);
        out.to=`${date.getFullYear()}-${add0(date.getMonth()+1)}-${add0(date.getDate())}`
    }
    return out
}


// zwraca tabele: classes, teachers, classrooms
async function getTable(tableName, id,oneDay=false,addDays=0){
    d=getDate(oneDay,addDays)
    const requestData = {
        __args:[ null,
        {
            "year": d.year,
            "datefrom": d.from,
            "dateto": d.to,
            "table": tableName,
            "id": String(id),
            "showColors": true,
            "showIgroupsInClasses": false,
            "showOrig": true
        }
    ], __gsh:"00000000"
    };

    const response = await axios.post('https://tebwroclaw.edupage.org/timetable/server/currenttt.js?__func=curentttGetData', requestData)
    return response.data.r.ttitems
}

// pobiera id klas, nauczycieli itp. do idList
idList={}
async function loadInitialData(){
    d=getDate()
    const requestData = {
    __args:['null',d.year,{
        "vt_filter":{
        "datefrom":d.from,
        "dateto":d.to
        }},
        {"op":"fetch","needed_part":{"teachers":["short"],"classes":["short","name"],"classrooms":["short"],"subjects":["short","name"]}}]
    , __gsh:"00000000"
    };

    const response = await axios.post('https://tebwroclaw.edupage.org/rpr/server/maindbi.js?__func=mainDBIAccessor', requestData)
    
    // tabele z danymi: teachers / subjects / classrooms / classes    
    for (const table of response.data.r.tables){
        idList[table.id]={}

        for (const row of table.data_rows){
        idList[table.id][row.id]={short:row.short}
        if (row.name)
            idList[table.id][row.id].name=row.name
        }
    }

    // zapis wszystkich klas z podziałem na roczniki
    for (const c in idList.classes){
        n=idList.classes[c].short
        process.stdout.write(n+' ');

        // pobieranie grup w klasie
        cards=await getTable("classes",c)
        groups=[]
        for (const c of cards){
            for (const g of c.groupnames){
                if (g!='' && !groups.includes(g))
                    groups.push(g)
            }
        }

        idList.classes[c].groups = groups
        idList.classes[c].year = parseInt(n[0])
    }
}

if (!config.debug){
    loadInitialData().then( ()=>{
        //fs.writeFileSync('sample_data/idList.json', JSON.stringify(idList, null, 2))
    })
}else{
    idList = JSON.parse(fs.readFileSync('sample_data/idList.json', 'utf-8'))
}

function find(name){
    // szukanie po nauczycielach, klasach, salach
    found={}
    for (const type in idList){
        if (!['teachers', 'classes', 'classrooms'].includes(type)) continue

        for (id in idList[type]){
            short=idList[type][id].short.toLowerCase()
            nm=name.toLowerCase()

            // jeśli bez literki F lub H, to też wyszuka
            if (short==nm || (type=='classrooms' && (short.slice(0, -1) == nm))){
                found.id=id
                found.type=type
                if (idList[type][id].name){ found.name=idList[type][id].name }
                else {found.name=idList[type][id].short}
                break
            }
        }
    }
    // false jeśli nie znaleziono
    if (Object.keys(found).length == 0) return false
    return found
}

// szuka klasy/nauczyciela/sali, zwraca discordową wiadomość lub false
async function where(name){

    found=find(name)
    if (!found) return
    
    out=`**${found.name}**`

    // pobieranie planu
    table = await getTable(found.type,found.id,true)
    
    // sprawdza czy jest jeszcze czas przed ostatnią lekcją w planie
    now = new Date()
    now = now.getHours()*60 + now.getMinutes()
    if (table.length != 0){
        arr = table.slice(-1)[0].endtime.split(':')
        time_last= parseInt(arr[0])*60 + parseInt(arr[1])
    }
    else {now = 0}

    // nie ma planu lub nie ma czasu
    if (table.length == 0 || now >= time_last ){
        now = 0
        // sprawdzanie tygodnia do przodu
        for (i=1; i<7; i++){
            table = await getTable(found.type,found.id,true,i)
            if (table.length != 0) break
        }

        if (table.length == 0){
            out +="\nnie ma planu na następny tydzień :c"
            return out
        }
    }

    // data
    out +=`  (${dniTygodnia[new Date(table[0].date).getDay()]}  ${table[0].date})`
    
    // przetwarzanie, i zmiana na wiadomość
    var arrow_placed=false
    for (const r of table){
        if (r.type != 'card') continue

        // lekcja od - do
        out+='\n``'+r['uniperiod']
        if (r['durationperiods']) out+=`-${parseInt(r['uniperiod'])+r['durationperiods']-1}`
        else out+='  '

        // godzina
        out+='`` ``'+r['starttime']+'-'+r['endtime']+'``'

        // sala, nauczyciel, klasa
        if (found.type != 'classrooms')out += ' ``' + idList.classrooms[r['classroomids'][0]].short.padEnd(4,' ').slice(0,4)+ '``'
        if (found.type != 'teachers') out += ' ``' + idList.teachers[r['teacherids'][0]].short + '``'
        if (found.type != 'classes') out += ' ``' + idList.classes[r['classids'][0]].short.padEnd(5,' ') + '``'
        // grupa
        if (r.groupnames[0] != ''){
            out+=' ``['
            for (g of r.groupnames) out+=g+', '
            out=out.slice(0, -2)+']``'
        }

        // przedmiot
        out+=' '+idList.subjects[r['subjectid']].short+''

        // strzałka
        if (!arrow_placed){
            arr=r['endtime'].split(':')
            const c_end=parseInt(arr[0])*60 + parseInt(arr[1])

            if (now <= c_end){
                out +=" :arrow_left:"
                arrow_placed=true
            }
        }
        
    }
    return out
}


module.exports = {
    idList,
    loadInitialData,
    where,
    find,
    getTable
};